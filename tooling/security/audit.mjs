#!/usr/bin/env node
// Dependency gate (OWASP A03): fail when a production dependency has a high or critical advisory, unless the
// advisory is accepted in audit-allowlist.json with a reason and a review date that hasn't passed.
//
//   node tooling/security/audit.mjs [--json <pnpm audit --json output>]
//
// No dependencies. Reads `pnpm audit --prod --json` (run here unless --json is given).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BLOCKING = new Set(["high", "critical"]);

export function evaluate(report, allowlist, today = new Date().toISOString().slice(0, 10)) {
  const accepted = new Map(allowlist.map((a) => [a.id, a]));
  const blocking = [];
  const allowed = [];
  const expired = [];
  for (const adv of Object.values(report.advisories ?? {})) {
    if (!BLOCKING.has(adv.severity)) continue;
    const id = adv.github_advisory_id ?? String(adv.id);
    const entry = { id, severity: adv.severity, module: adv.module_name, title: adv.title, paths: [...new Set((adv.findings ?? []).flatMap((f) => f.paths ?? []))].slice(0, 3) };
    const a = accepted.get(id);
    if (!a) blocking.push(entry);
    else if (!a.reviewBy || a.reviewBy < today) expired.push({ ...entry, reviewBy: a.reviewBy });
    else allowed.push({ ...entry, reason: a.reason });
  }
  return { ok: blocking.length === 0 && expired.length === 0, blocking, allowed, expired };
}

function main() {
  const i = process.argv.indexOf("--json");
  let raw;
  if (i > 0) raw = readFileSync(process.argv[i + 1], "utf8");
  else {
    try {
      raw = execFileSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
    } catch (e) {
      raw = e.stdout; // pnpm audit exits non-zero when it finds anything
    }
  }
  const report = JSON.parse(raw);
  const allowlist = JSON.parse(readFileSync(join(here, "audit-allowlist.json"), "utf8")).accepted ?? [];
  const r = evaluate(report, allowlist);
  for (const a of r.allowed) console.log(`accepted  ${a.severity} ${a.id} ${a.module}: ${a.reason}`);
  for (const a of r.expired) console.log(`EXPIRED   ${a.severity} ${a.id} ${a.module}: review was due ${a.reviewBy}`);
  for (const a of r.blocking) console.log(`BLOCKING  ${a.severity} ${a.id} ${a.module}: ${a.title} (${a.paths.join("; ")})`);
  const v = report.metadata?.vulnerabilities ?? {};
  console.log(`\nadvisories: critical ${v.critical ?? 0}, high ${v.high ?? 0}, moderate ${v.moderate ?? 0}, low ${v.low ?? 0}`);
  if (!r.ok) {
    console.log("✕ dependency gate: fix, override (pnpm-workspace.yaml) or accept with a reason in tooling/security/audit-allowlist.json");
    process.exit(1);
  }
  console.log("✓ dependency gate: no unaccepted high or critical advisories");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
