// Port inventory for pixvault-team-media (PV0 / PV-1).
//
// Walks checkouts of MarSeventh/CloudFlare-ImgBed and MarSeventh/Sanyue-ImgHub at their pinned refs and writes
// one row per source file, each with a decision (port | adapt | replace | drop | import-only), its reason, the
// target milestone, component and test id, and a status. A file that no rule matches fails the run, so an upstream
// bump (PV-E) can't silently skip a file.
//
//   node tools/port-inventory/inventory.ts --imgbed <dir> --imghub <dir> [--out specs/epics/pixvault-team-media/port] [--check]
//
// Node >= 22.18 runs this file directly (type stripping). Only node: built-ins are used.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const IMGBED_REF = "611153e47cc839ecf28b344bcd233032a37cc216";
export const IMGHUB_REF = "1621525ce523782852d46d43c4cf3d036dda520b";

type Decision = "port" | "adapt" | "replace" | "drop" | "import-only";
type Status = "planned" | "in-progress" | "verified" | "dropped" | "import-only" | "deferred" | "blocked";
type Origin = "brief" | "pv1-decision";

export interface Row {
  id: string;
  repo: "CloudFlare-ImgBed" | "Sanyue-ImgHub";
  source: string;
  decision: Decision;
  reason: string;
  origin: Origin;
  milestone: string;
  component: string;
  target: string | null;
  testId: string | null;
  taskKey: string | null;
  status: Status;
}

interface Rule {
  match: RegExp;
  decision: Decision;
  reason: string;
  origin: Origin;
  milestone: string;
  component: string;
  /** Directory the ported file lands in; null when nothing lands (drop, replace). */
  targetDir: string | null;
  test: string | null;
}

const r = (
  match: RegExp,
  decision: Decision,
  milestone: string,
  component: string,
  targetDir: string | null,
  test: string | null,
  reason: string,
  origin: Origin = "brief",
): Rule => ({ match, decision, milestone, component, targetDir, test, reason, origin });

// Ordered: the first match wins. "brief" rows restate the epic brief's fixed decisions; "pv1-decision" rows are
// the decisions taken in the PV-1 PR for files the brief's table doesn't name.
export const IMGBED_RULES: Rule[] = [
  // replace: Cirrus already has it
  r(/^functions\/api\/auth\//, "replace", "PV1", "identity-worker + membership-worker + policy-worker", null, "tenancy/isolation", "single admin password and sessions → Cirrus identity, membership and policy"),
  r(/^functions\/utils\/auth\//, "replace", "PV1", "identity-worker + policy-worker", null, "tenancy/isolation", "admin/user dual auth → Cirrus sessions, API keys and policy checks"),
  r(/^functions\/api\/manage\/apiTokens\.js$/, "replace", "PV9", "identity-worker (API keys)", null, "api/keys-scope", "ImgBed API tokens → Cirrus API keys scoped to org, library and role"),
  r(/^functions\/api\/manage\/sysConfig\/security\.js$/, "replace", "PV1", "config-worker + media-worker (library settings)", null, "tenancy/isolation", "global security config → org and library settings"),
  // import-only: one-way migration sources, never storage
  r(/^functions\/utils\/storage\/(telegramAPI|discordAPI|huggingfaceAPI|webdavAPI)\.js$/, "import-only", "PV10", "media-worker import", "apps/media-worker/src/import/sources", "import/sources", "free channel is not a storage backend; kept only as a one-way import source"),
  r(/^functions\/upload\/huggingface\//, "import-only", "PV10", "media-worker import", "apps/media-worker/src/import/sources/huggingface", "import/sources", "Hugging Face upload path is not storage; informs the HF import source"),
  r(/^functions\/api\/channels\.js$/, "import-only", "PV10", "media-worker import", "apps/media-worker/src/import", "import/sources", "load balancing between free channels has no place in managed/BYO storage; its channel list shapes the import wizard"),
  // drop
  r(/^functions\/api\/bing\//, "drop", "PV1", "—", null, null, "Bing wallpaper proxy: upstream default background, not product"),
  r(/^deploy\/server\//, "drop", "PV1", "—", null, null, "Docker/Node server edition; the product runs on Workers only"),
  r(/^Dockerfile$/, "drop", "PV1", "—", null, null, "Docker edition is out of scope (design §5)"),
  // adapt: keep behaviour, change the model
  r(/^functions\/upload\/(index|chunkUpload|chunkMerge|uploadTools|_middleware)\.js$/, "adapt", "PV2", "media-worker uploads", "apps/media-worker/src/upload", "upload/e2e", "direct-to-storage sessions, multipart, dedup and quotas replace in-Worker relaying; the request/response contract is kept for /upload (PV9)"),
  r(/^functions\/file\/imageTransform\.js$/, "adapt", "PV3", "serve-worker transforms", "apps/serve-worker/src/transform", "serve/contract", "in-Worker transform is the fallback where Image Transformations is unavailable"),
  r(/^functions\/file\//, "adapt", "PV3", "serve-worker", "apps/serve-worker/src/file", "serve/contract", "serving via KV route + storage read, with signed URLs and per-library access rules"),
  r(/^functions\/random\//, "adapt", "PV3", "serve-worker random", "apps/serve-worker/src/random", "serve/random", "random-image API scoped to one library and folder, public only if the library allows"),
  r(/^functions\/dav\//, "adapt", "PV9", "dav-worker", "apps/dav-worker/src", "dav/litmus", "WebDAV per library with per-user app passwords"),
  r(/^functions\/utils\/storage\/s3Client\.js$/, "adapt", "PV7", "storage-worker ObjectStore", "apps/storage-worker/src/stores", "storage/byo-e2e", "S3 client becomes the s3-compatible ObjectStore; managed R2 uses the binding (PV2)"),
  r(/^functions\/utils\/(indexManager|d1Database|databaseAdapter)\.js$/, "adapt", "PV2", "LibraryIndex DO", "apps/media-worker/src/index", "index/consistency", "KV/D1 file index replaced by the per-library SQLite Durable Object (design §1.3)"),
  r(/^functions\/api\/public\/list\.js$/, "adapt", "PV6", "media-worker collections", "apps/media-worker/src/public", "share/guest-scope", "public directory listing becomes collection galleries and share-link listings"),
  r(/^functions\/api\/directoryTree\.js$/, "adapt", "PV5", "media-worker folders", "apps/media-worker/src/folders", "browse/folders", "folder tree served from the DO's folders table"),
  r(/^functions\/api\/manage\/ai\//, "adapt", "PV4", "pipeline AI tags", "apps/media-worker/src/pipeline/ai", "pipeline/ai-tags", "AI tagging moves into ProcessFileWorkflow; Workers AI by default"),
  r(/^functions\/api\/manage\/(block|white)\//, "adapt", "PV4", "media-worker review + serve-worker blocked list", "apps/media-worker/src/moderation", "safety/hold", "block/allow a file → moderation actions and the 451 blocked list"),
  r(/^functions\/api\/manage\/cusConfig\//, "adapt", "PV3", "serve-worker access rules", "apps/serve-worker/src/access", "serve/access-rules", "IP block/allow lists become per-library access rules"),
  r(/^functions\/api\/manage\/(list|move|rename|metadata)(\.js|\/)/, "adapt", "PV5", "media-worker files", "apps/media-worker/src/files", "browse/e2e", "list, move, rename and metadata as DO transactions"),
  r(/^functions\/api\/manage\/delete\//, "adapt", "PV2", "media-worker trash", "apps/media-worker/src/files", "upload/e2e", "delete goes to trash with retention; purge by Workflow at refcount 0"),
  r(/^functions\/api\/manage\/tags\//, "adapt", "PV5", "media-worker tags", "apps/media-worker/src/tags", "browse/tags", "tags and autocomplete from the DO's tags tables and FTS5"),
  r(/^functions\/api\/manage\/(expiry|dedup\/scan|quota)\.js$|^functions\/api\/manage\/dedup\//, "adapt", "PV2", "media-worker", "apps/media-worker/src/files", "upload/e2e", "expiry per file, dedup by SHA-256 at commit, quotas through Cirrus metering"),

  // ---- decisions taken in PV-1 for files outside the brief's table ----
  r(/^functions\/api\/manage\/batch\/index\//, "drop", "PV2", "—", null, null, "index rebuild in chunks exists because KV listing is slow; the DO index is authoritative and restored from its nightly export", "pv1-decision"),
  r(/^functions\/api\/manage\/batch\/(list|settings)\.js$|^functions\/api\/manage\/batch\/restore\//, "adapt", "PV10", "media-worker import (ImgBed backup)", "apps/media-worker/src/import/imgbed", "import/imgbed-fixture", "ImgBed backup/restore format is the input of the ImgBed importer", "pv1-decision"),
  r(/^functions\/api\/manage\/_middleware\.js$|^functions\/api\/_middleware\.js$|^functions\/_middleware\.js$|^functions\/utils\/middleware\.js$/, "replace", "PV1", "api-edge", null, "tenancy/isolation", "auth, CORS and error middleware come from Cirrus api-edge", "pv1-decision"),
  r(/^functions\/(upload|file|random|dav)\/_middleware\.js$/, "adapt", "PV1", "owning worker middleware", "apps/media-worker/src/middleware", "tenancy/isolation", "per-route guards rebuilt on Cirrus actor resolution", "pv1-decision"),
  r(/^functions\/api\/manage\/sysConfig\/(upload|others)\.js$/, "adapt", "PV1", "media-worker library settings", "apps/media-worker/src/libraries", "libraries/settings", "upload rules and misc options become library settings; channel config is replaced by storage_backends (PV7)", "pv1-decision"),
  r(/^functions\/api\/manage\/sysConfig\/ai\.js$/, "adapt", "PV4", "media-worker library settings (AI)", "apps/media-worker/src/libraries", "pipeline/ai-tags", "AI provider settings per org; OpenAI-compatible key only if an admin adds one", "pv1-decision"),
  r(/^functions\/api\/manage\/sysConfig\/page\.js$/, "drop", "PV1", "—", null, null, "site page customisation (backgrounds, announcement, upstream branding) is replaced by the Pixvault brand", "pv1-decision"),
  r(/^functions\/api\/userConfig\.js$/, "adapt", "PV1", "media-worker library settings (public)", "apps/media-worker/src/libraries", "libraries/settings", "public client config becomes the library's public upload rules", "pv1-decision"),
  r(/^functions\/api\/fetchRes\.js$/, "adapt", "PV2", "media-worker URL upload", "apps/media-worker/src/upload", "upload/url-ssrf", "URL upload fetcher kept with an SSRF guard (no private ranges, size cap)", "pv1-decision"),
  r(/^functions\/utils\/ai\//, "adapt", "PV4", "pipeline AI", "apps/media-worker/src/pipeline/ai", "pipeline/ai-tags", "AI capability, provider and tag helpers used by ProcessFileWorkflow", "pv1-decision"),
  r(/^functions\/utils\/(fileExpiryHelpers|fileExpiryService)\.js$/, "adapt", "PV4", "pipeline expiry Workflow", "apps/media-worker/src/pipeline/expiry", "pipeline/expiry", "file expiry as a purge Workflow; 'expires at' per file or upload link", "pv1-decision"),
  r(/^functions\/utils\/deleteBatch\.js$/, "adapt", "PV5", "media-worker bulk", "apps/media-worker/src/files", "browse/bulk", "bulk delete to trash as batched DO transactions", "pv1-decision"),
  r(/^functions\/utils\/(tagHelpers|tagService)\.js$/, "adapt", "PV5", "media-worker tags", "apps/media-worker/src/tags", "browse/tags", "tag normalisation and queries over the DO", "pv1-decision"),
  r(/^functions\/utils\/metadata\/(channelConfig|channelCredentials)\.js$/, "replace", "PV7", "storage-worker storage_backends", null, "storage/byo-e2e", "channel config and credentials → storage_backends with envelope-encrypted credentials", "pv1-decision"),
  r(/^functions\/utils\/metadata\/(metadataSecurity|metadataView)\.js$/, "adapt", "PV3", "media-worker file view", "apps/media-worker/src/files", "serve/contract", "never expose storage internals in file metadata responses", "pv1-decision"),
  r(/^functions\/utils\/mimeTypes\.js$/, "port", "PV2", "packages/shared media types", "packages/shared/src/media", "upload/e2e", "MIME table reused as is", "pv1-decision"),
  r(/^functions\/utils\/uploadFormat\.js$/, "port", "PV9", "media-worker ImgBed-compatible upload", "apps/media-worker/src/compat", "upload/compat", "response formats are the compatibility contract (PV-F)", "pv1-decision"),
  r(/^functions\/utils\/purgeCache\.js$/, "adapt", "PV3", "serve-worker cache purge", "apps/serve-worker/src/cache", "serve/contract", "purge on move, delete, visibility change and takedown", "pv1-decision"),
  r(/^functions\/utils\/(apiResponse|projectHeaders)\.js$/, "replace", "PV1", "packages/shared errors", null, null, "Cirrus error envelope and headers; upstream project headers are brand", "pv1-decision"),
  r(/^functions\/utils\/sysConfig\.js$/, "replace", "PV1", "config-worker", null, "libraries/settings", "global KV config → Cirrus config-worker settings and flags", "pv1-decision"),
  r(/^database\/(init\.sql|migrations\/)/, "replace", "PV1", "packages/db migration 200_media_control + LibraryIndex schema", null, "tenancy/isolation", "single-tenant schema → org-scoped D1 control tables and the per-library DO schema", "pv1-decision"),
  r(/^deploy\/(worker|profiles)\//, "drop", "PV1", "—", null, null, "upstream wrangler generation; Cirrus intent.yaml and components deploy the fleet", "pv1-decision"),
];

export const IMGHUB_RULES: Rule[] = [
  r(/^src\/(views\/(AdminLogin|Login)\.vue|components\/BaseLogin\.vue)$/, "replace", "PV1", "Cirrus identity sign-in", null, "app/auth", "single-admin login pages → Cirrus sign-in (shared session)"),
  r(/^src\/(mixins\/backgroundManager\.js|styles\/background\.css)$/, "drop", "PV1", "—", null, null, "Bing wallpaper and anime default backgrounds are removed"),
  r(/^src\/assets\/fonts\//, "drop", "PV1", "—", null, "brand/grep", "upstream wordmark display fonts (Pacifico, UnidreamLED) are part of the upstream look; Pixvault ships its own type", "pv1-decision"),
  r(/\.(png|jpe?g|gif|webp|ico|apng|svg)$/, "drop", "PV1", "—", null, "brand/grep", "upstream images and logos are brand marks; replaced by Pixvault assets", "pv1-decision"),
  r(/^src\/components\/(Logo|Footer)\.vue$/, "replace", "PV1", "media-web brand", null, "brand/grep", "upstream logo and footer links are brand marks", "pv1-decision"),
  r(/^src\/components\/icons\/ChannelIcon\.vue$/, "drop", "PV1", "—", null, null, "storage channels are gone (Telegram/Discord/HF)", "pv1-decision"),
  r(/^src\/(utils\/(axios|fetchWithAuth|tokenExpiration)\.js)$/, "replace", "PV1", "media-web Cirrus client", "apps/media-web/src/api", "app/auth", "auth-code fetch helpers → Cirrus session + facades", "pv1-decision"),
  r(/^src\/(App\.vue|main\.js|router\/|store\/|locales\/|styles\/|entry\/|components\/(LanguageSwitcher|ToggleDark|DashboardTabs|FloatingSaveButton|LanguageSwitcher)\.vue|utils\/fontawesomeIcons\.js|views\/NotFound\.vue|mixins\/unsavedSettings\.js)/, "adapt", "PV1", "media-web shell", "apps/media-web/src", "app/shell", "app shell, router, store, i18n and themes, rebranded, with org/library switcher", "pv1-decision"),
  r(/^src\/(views\/UploadHome\.vue|components\/upload\/|utils\/upload\/|utils\/(fileIdValidator|pathValidator|mimeTypes)\.js)/, "adapt", "PV2", "media-web upload page", "apps/media-web/src", "app/upload", "upload page with presigned/multipart sessions and SHA-256 in the browser", "pv1-decision"),
  r(/^src\/(components\/browse\/TransformMedia\.vue|utils\/dashboard\/fileLinks\.js)$/, "adapt", "PV3", "media-web links + transforms", "apps/media-web/src", "app/links", "links (public or signed) with transform presets", "pv1-decision"),
  r(/^src\/(views\/AdminDashBoard\.vue|components\/dashboard\/(?!AITagPanel)|components\/(DirectoryTreePicker|DirectorySuggestionInput|DateRangeCalendar)\.vue|utils\/dashboard\/|utils\/(batchProcessor|fileManager|mediaManager)\.js)/, "adapt", "PV5", "media-web library browser", "apps/media-web/src", "app/browse", "library browser, bulk bar, drawer and filters, live over WebSocket", "pv1-decision"),
  r(/^src\/(components\/dashboard\/AITagPanel\.vue|components\/icons\/AIIcon\.vue|utils\/aiTags\.js|components\/config\/SysCogAI\.vue)$/, "adapt", "PV4", "media-web AI tags", "apps/media-web/src", "app/ai-tags", "AI tags (user vs ai source) in the drawer and settings", "pv1-decision"),
  r(/^src\/(views\/BlockImage\.vue|views\/WhiteListOn\.vue)$/, "adapt", "PV4", "serve-worker public pages", "apps/serve-worker/src/pages", "safety/takedown", "451 takedown and held-for-review notice pages", "pv1-decision"),
  r(/^src\/(utils\/fileExpiry\.js|components\/config\/FileExpirySettings\.vue)$/, "adapt", "PV4", "media-web expiry", "apps/media-web/src", "pipeline/expiry", "per-file and per-upload-link expiry", "pv1-decision"),
  r(/^src\/views\/PublicBrowse\.vue$/, "adapt", "PV6", "media-web collections gallery", "apps/media-web/src", "share/guest-scope", "public gallery for collections and share links", "pv1-decision"),
  r(/^src\/views\/CustomerConfig\.vue$/, "adapt", "PV3", "media-web access rules", "apps/media-web/src", "serve/access-rules", "referrer and IP rules per library", "pv1-decision"),
  r(/^src\/(views\/SystemConfig\.vue|components\/config\/(SysConfigTabs|SysCogUpload|SysCogOthers|SysCogSecurity|SysCogStatus|CustomSelect|FileFormatSettings)\.vue)$/, "adapt", "PV1", "media-web library settings", "apps/media-web/src", "libraries/settings", "library settings screen (storage and domain tabs land in PV7/PV8)", "pv1-decision"),
  r(/^src\/components\/config\/SysCogPage\.vue$/, "drop", "PV1", "—", null, null, "site page customisation is upstream branding", "pv1-decision"),
  r(/^src\/utils\/(backupGenerator|restoreProcessor|indexRebuilder)\.js$/, "drop", "PV10", "—", null, null, "client-side backup/restore and index rebuild are replaced by server import (PV10) and DO export", "pv1-decision"),
  r(/^public\/(index\.html|_headers)$/, "adapt", "PV1", "media-web static", "apps/media-web/public", "brand/grep", "HTML shell and headers rebranded", "pv1-decision"),
];

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (name === ".git" || name === "node_modules") continue;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
}

function headOf(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[[\]]/g, "").toLowerCase();

function targetFor(rule: Rule, source: string): string | null {
  if (!rule.targetDir) return null;
  const base = source.split("/").pop() ?? source;
  if (base.endsWith(".vue") || base.endsWith(".css") || base.endsWith(".json") || base.endsWith(".html") || base === "_headers") {
    return `${rule.targetDir}/${source.replace(/^(src|public)\//, "")}`.replace(/\/\/+/g, "/");
  }
  const stem = base.replace(/\.(m?js|ts)$/, "");
  const name = stem === "[[path]]" ? "path" : kebab(stem);
  return `${rule.targetDir}/${name}.ts`;
}

function classify(repo: Row["repo"], prefix: string, files: string[], rules: Rule[]): { rows: Row[]; unmatched: string[] } {
  const rows: Row[] = [];
  const unmatched: string[] = [];
  let n = 0;
  for (const source of files) {
    const rule = rules.find((x) => x.match.test(source));
    if (!rule) {
      unmatched.push(source);
      continue;
    }
    n += 1;
    rows.push({
      id: `${prefix}-${String(n).padStart(3, "0")}`,
      repo,
      source,
      decision: rule.decision,
      reason: rule.reason,
      origin: rule.origin,
      milestone: rule.milestone,
      component: rule.component,
      target: targetFor(rule, source),
      testId: rule.test,
      taskKey: null,
      status: rule.decision === "drop" ? "dropped" : "planned",
    });
  }
  return { rows, unmatched };
}

/** Keep hand-maintained fields (taskKey, status) from an existing inventory, keyed by source path. */
function carry(rows: Row[], previousPath: string): Row[] {
  if (!existsSync(previousPath)) return rows;
  const prev = new Map<string, Row>((JSON.parse(readFileSync(previousPath, "utf8")).rows as Row[]).map((x) => [x.source, x]));
  return rows.map((row) => {
    const old = prev.get(row.source);
    return old && old.decision === row.decision ? { ...row, taskKey: old.taskKey, status: old.status } : row;
  });
}

function render(imgbed: Row[], imghub: Row[]): string {
  const all = [...imgbed, ...imghub];
  const count = (k: keyof Row) => {
    const m = new Map<string, number>();
    for (const x of all) m.set(String(x[k]), (m.get(String(x[k])) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }));
  };
  const lines: string[] = [];
  lines.push("# Port inventory", "");
  lines.push("Generated by `tools/port-inventory/inventory.ts`. Don't edit by hand: change a rule and re-run.", "");
  lines.push(`- CloudFlare-ImgBed @ \`${IMGBED_REF.slice(0, 7)}\`: ${imgbed.length} files (functions/**, database/**, deploy/**, Dockerfile)`);
  lines.push(`- Sanyue-ImgHub @ \`${IMGHUB_REF.slice(0, 7)}\`: ${imghub.length} files (src/**, public/**)`, "");
  lines.push("| Decision | Rows |", "|---|---|", ...count("decision").map(([k, v]) => `| ${k} | ${v} |`), "");
  lines.push("| Milestone | Rows |", "|---|---|", ...count("milestone").map(([k, v]) => `| ${k} | ${v} |`), "");
  lines.push("| Status | Rows |", "|---|---|", ...count("status").map(([k, v]) => `| ${k} | ${v} |`), "");
  for (const [title, rows] of [["CloudFlare-ImgBed", imgbed], ["Sanyue-ImgHub", imghub]] as const) {
    lines.push(`## ${title}`, "", "| Id | Source | Decision | Milestone | Target | Test | Task | Status | Reason |", "|---|---|---|---|---|---|---|---|---|");
    for (const x of rows) {
      lines.push(`| ${x.id} | \`${x.source}\` | ${x.decision}${x.origin === "pv1-decision" ? "¹" : ""} | ${x.milestone} | ${x.target ? `\`${x.target}\`` : x.component} | ${x.testId ?? "—"} | ${x.taskKey ?? "—"} | ${x.status} | ${x.reason} |`);
    }
    lines.push("");
  }
  lines.push("¹ Decided in the PV-1 PR; the brief's fixed table doesn't name this file.", "");
  return lines.join("\n");
}

function main(argv: string[]): number {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const imgbedDir = arg("--imgbed");
  const imghubDir = arg("--imghub");
  const out = arg("--out") ?? "specs/epics/pixvault-team-media/port";
  const check = argv.includes("--check");
  if (!imgbedDir || !imghubDir) {
    console.error("usage: inventory.ts --imgbed <checkout> --imghub <checkout> [--out dir] [--check]");
    return 2;
  }
  for (const [dir, ref] of [[imgbedDir, IMGBED_REF], [imghubDir, IMGHUB_REF]] as const) {
    const head = headOf(dir);
    if (head !== ref) {
      console.error(`${dir} is at ${head}, expected ${ref}. Port from the pinned ref only (PV-E).`);
      return 1;
    }
  }
  const ib: string[] = [];
  walk(imgbedDir, "", ib);
  const ibFiles = ib.filter((p) => /^(functions|database|deploy)\//.test(p) || p === "Dockerfile").sort();
  const ih: string[] = [];
  walk(imghubDir, "", ih);
  const ihFiles = ih.filter((p) => /^(src|public)\//.test(p)).sort();

  const a = classify("CloudFlare-ImgBed", "IB", ibFiles, IMGBED_RULES);
  const b = classify("Sanyue-ImgHub", "IH", ihFiles, IMGHUB_RULES);
  const unmatched = [...a.unmatched.map((p) => `CloudFlare-ImgBed:${p}`), ...b.unmatched.map((p) => `Sanyue-ImgHub:${p}`)];
  if (unmatched.length) {
    console.error(`${unmatched.length} file(s) have no decision; add a rule with a reason:\n  ${unmatched.join("\n  ")}`);
    return 1;
  }

  const imgbedRows = carry(a.rows, join(out, "imgbed.json"));
  const imghubRows = carry(b.rows, join(out, "imghub.json"));
  const files: Record<string, string> = {
    "imgbed.json": JSON.stringify({ repo: "MarSeventh/CloudFlare-ImgBed", ref: IMGBED_REF, rows: imgbedRows }, null, 2) + "\n",
    "imghub.json": JSON.stringify({ repo: "MarSeventh/Sanyue-ImgHub", ref: IMGHUB_REF, rows: imghubRows }, null, 2) + "\n",
    "README.md": render(imgbedRows, imghubRows),
  };
  if (check) {
    const stale = Object.entries(files).filter(([name, body]) => !existsSync(join(out, name)) || readFileSync(join(out, name), "utf8") !== body);
    if (stale.length) {
      console.error(`inventory is stale: ${stale.map(([n]) => n).join(", ")}; re-run without --check`);
      return 1;
    }
    console.log("inventory is current");
    return 0;
  }
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body);
  console.log(`wrote ${imgbedRows.length} ImgBed + ${imghubRows.length} ImgHub rows to ${relative(process.cwd(), out) || out}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
