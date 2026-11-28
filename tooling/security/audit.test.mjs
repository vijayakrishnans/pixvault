import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./audit.mjs";

const adv = (id, severity, module = "pkg") => ({ github_advisory_id: id, severity, module_name: module, title: `t ${id}`, findings: [{ paths: [`app>${module}`] }] });
const report = (...a) => ({ advisories: Object.fromEntries(a.map((x, i) => [String(i), x])) });

test("high and critical advisories block; moderate and low don't", () => {
  const r = evaluate(report(adv("GHSA-1", "critical"), adv("GHSA-2", "high"), adv("GHSA-3", "moderate"), adv("GHSA-4", "low")), []);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocking.map((b) => b.id), ["GHSA-1", "GHSA-2"]);
});

test("an accepted advisory passes until its review date, then blocks again", () => {
  const allow = [{ id: "GHSA-2", reason: "build-time only", reviewBy: "2026-12-31" }];
  assert.equal(evaluate(report(adv("GHSA-2", "high")), allow, "2026-12-01").ok, true);
  const late = evaluate(report(adv("GHSA-2", "high")), allow, "2027-01-01");
  assert.equal(late.ok, false);
  assert.deepEqual(late.expired.map((e) => e.id), ["GHSA-2"]);
  assert.equal(evaluate(report(adv("GHSA-2", "high")), [{ id: "GHSA-2", reason: "no date" }]).ok, false);
});

test("a clean report passes", () => {
  assert.equal(evaluate({ advisories: {} }, []).ok, true);
});
