# Pixvault ledger

Read this first on every resume. State that a tool can answer (`task_get pixvault-team-media`, `gh pr list
--state all`, `runs_list`) wins over this file; this file holds what tools can't answer: inputs, decisions and why,
measured numbers, deferred items.

## Inputs actually used

| Input | Value |
|---|---|
| Orunbase account | `openproduct-6ny98czp` (`ws_6NY98CZP`): the user's choice on 2026-11-27, replacing the brief's `openproduct-sms84q22`, where this login has no account role |
| Workspace | `Pixvault` / `pixvault` / **`ws_KG0H9PEH`** (public) |
| Cloudflare connection | `int_4da7181983a946dbbc3bb62a9aae9a6c` (the account's active one). The brief's `nexo` is revoked on this account and is not reconnected |
| GitHub connection | `int_e4aad5421dea4f2c85f65f75f05e9faf` → owner **vijayakrishnans** |
| workers.dev subdomain | `vijayakrishnan12994` (verified against a live Worker on the same connection) |
| Repo | https://github.com/vijayakrishnans/pixvault (public) |
| Baseline | `cirrus-baseline` `baseline-v29`. `cirrus` is retired in the registry and this is its successor |
| Product domain | none yet; `pixvault.app` isn't registered (WAITING W-6) |
| IMGBED_REF | `MarSeventh/CloudFlare-ImgBed@611153e47cc839ecf28b344bcd233032a37cc216` (2026-11-21) |
| IMGHUB_REF | `MarSeventh/Sanyue-ImgHub@1621525ce523782852d46d43c4cf3d036dda520b` (2026-11-21) |
| Epic | EP-2 `pixvault-team-media` (`epc_MZ72W460`); the bootstrap's own epic is EP-1 `infra-baselining` |

## Live URLs

| | stage | prod |
|---|---|---|
| api-edge | https://pixvault-api-edge-stage.vijayakrishnan12994.workers.dev | https://pixvault-api-edge-prod.vijayakrishnan12994.workers.dev |
| console | https://pixvault-web-console-next-stage.vijayakrishnan12994.workers.dev | https://pixvault-web-console-next-prod.vijayakrishnan12994.workers.dev |
| app (PV-6) | https://pixvault-media-web-stage.vijayakrishnan12994.workers.dev | https://pixvault-media-web-prod.vijayakrishnan12994.workers.dev |
| files (PV3) | https://pixvault-serve-worker-stage.vijayakrishnan12994.workers.dev | https://pixvault-serve-worker-prod.vijayakrishnan12994.workers.dev |

## Skill revisions run under (registry, 2026-11-27)

orunbase `fe17c72a`, software-factory `ac5be085` (same as the brief), pr-provenance `ea0af746`, design-authoring
`e6ed5ba1`, initiative-lifecycle `9ed675c8`, milestone-loop `8a814c28`, task-branch-pr `83c7d906`, orun-cli
`8c475ab2`, planning `6caf76f6`, mcp-tools `d070d616`. Full hashes are in the PR manifests.

## Decisions

- 2026-11-27: **Baseline `cirrus-baseline` v29**, not `cirrus` (retired). Same workers and conventions.
- 2026-11-27: **Facades at `/v1/organizations/{orgId}/libraries/…`**, Cirrus's real shape (brief rule 5).
- 2026-11-27: **`productdomain` empty** at bootstrap. The domain isn't owned, and the blueprint makes the domain an
  owner's step after the first deploy.
- 2026-11-27: **Licence holder "OpenProduct"**, matching the other OpenProduct repos.
- 2026-11-27: **No `orun/compliance` check is posted on this repo** (bootstrap PRs #1 and #2 had none either). The
  pen is still kept (branch, trailer, manifest, contract) and `orun task check` runs locally before every push.

## Decisions (PV4)

- 2026-11-27, the user: **build PV4 on Workflows**, not Queues (W-3 can't mint a Queues scope). GAPS G56.
- Moderation model `@cf/mistralai/mistral-small-3.1-24b-instruct` (vision, no licence prompt); tags
  `@cf/microsoft/resnet-50`. Both are vars (`MODERATION_MODEL`, `TAGS_MODEL`). Upstream sent images to third-party
  services (moderatecontent.com, an nsfwjs endpoint); Pixvault keeps them inside the account.

## Decisions (PV2)

- 2026-11-27: **Managed uploads stream through media-worker** into R2 multipart over the binding (no presigned
  URLs; no S3 keys in a Worker; no bucket CORS). Presigning arrives with BYO in PV7.
- 2026-11-27: **Quotas live in media tables**, because metering's routes are owner/admin-only (PV-L follow-up).
- 2026-11-27: **Workers Logs on media-worker** (PV-12), ids and sizes only. They found the PV-13 memory bug in
  minutes.

## Decisions (PV1)

- 2026-11-27: **Solo profile off (PV-5).** The baseline shipped single-user, and teams need orgs, members,
  invitations and API keys.
- 2026-11-27: **Library roles decided by policy-worker.** `library_role` facts are evaluated in
  `packages/policy-engine/src/library.ts`; consumers of the engine must be redeployed (`# orun: redeploy` trigger).
- 2026-11-27: **`orun task check` matches `affects` by exact qualified component id** (`default/pixvault/<name>`),
  so every contract lists the components it changes.

## Measured

- Bootstrap: 08:07:23Z → 08:13:45Z on 2026-11-27 (about 6.5 min, exit 0); 42 components × 3 envs → 89 jobs.
- `/health` right after the bootstrap: stage 0.65 s, prod 0.54 s (cold, from WSL in India).
- PV1 tests: policy matrix 1,200 cases (suite 1,434); media-worker 31 over real SQLite; media facade 14; media-web 24.
- PV1 live smoke on stage (2026-11-27): 17/17 checks, including 6 cross-org probes returning 404.
- PV2 stage acceptance (2026-11-27): 14/14. 1 KB, 10 MB, 200 MB and 2 GB commit with matching SHA-256; 2 GB =
  60 parts, ~600 s upload at ~3.3 MB/s, 87 s verify and index. Resume, dedup, trash/restore/purge and quota all
  pass. DO commit throughput is 5.4 commits/s at concurrency 10 (p50 1.7 s, p95 2.4 s).
- Latency: a D1 query is ~250 ms from the stage edge (Cirrus `GET projects` db;dur=251); `/health` 454 ms; index
  list 354 ms downstream.
- Workers Paid confirmed (W-4): a 200 MB commit hashes in one request, far beyond the free plan's 10 ms of CPU.
- PV3 stage acceptance (2026-11-27): 9/9 functional checks. Exact bytes served; the same path under another
  library 404; private without signature 404; signed link 200 (`private, no-store`); active types download; tampered
  signature 404; altered expiry refused; preset thumb → WebP (1,949 B → 48 B synthetic PNG); unknown preset 400.
- PV3 latency: worker time (Server-Timing) for a cached public file p50 6 ms, **p95 9 ms**, p99 587 ms over 150
  requests (148 cache hits); preset p95 6 ms. Client TTFB from the build box: p50 50 ms, p95 224–339 ms, with
  `/health` alone at p95 321–352 ms and some connect timeouts, so the tail is this client's network (G53).
- PV3 propagation (PV-21, 2026-11-27): a switch to public served after 51 s with KV `cacheTtl` 60; with 30 (KV's
  minimum) 21.6 s, 20.8 s, 20.5 s over three runs. Headless Links flow on the stage app: 11/11.
- PV4 stage (2026-11-28): a canvas-drawn JPEG with a made-up GPS IFD → `processing` at commit → public 14.1–14.5 s
  later with `removed:exif.gps`, 320×200 recorded; stored, downloaded and served bytes carry no GPS (8/8). The real
  moderation model (`@cf/mistralai/mistral-small-3.1-24b-instruct`) passed it; tags `["envelope"]`. PV-23's first
  run held it (`moderation_unavailable`): the binding returns the answer already parsed, fixed in PV-24.
- PV4 takedown (2026-11-28): report through `/_report` → case listed for a temporary stage operator → takedown →
  **451 after 3.3 s** at a warmed edge; reinstate → public. The operator row was removed afterwards (0 operators).
- PV-28 stage (2026-11-28): two members' sockets on one library; the owner uploads 5 files. The teammate's socket
  heard each commit 944–1,325 ms after the commit request was sent (about 0.6 s before the owner's own commit
  response returned). A used ticket was refused; presence showed both people and the owner's folder, and dropped a
  closed socket; events carried no file names (7/7).
- PV5 two-browser run on stage (2026-11-28, with PV-30's build served in place of the deployed bundle): the owner and
  a guest viewer open one library; both go live and see each other. The owner drops a 640 B file: the upload takes
  5.4–5.9 s end to end (hash, session, part, commit at ~250 ms per D1 query, G34), and the viewer's grid shows it 4–34 ms
  *before* the owner's queue reports "Uploaded". Then a new folder, a bulk move into it (the viewer's tree follows
  live), search, the drawer with its version and folder, list view, and a phone width with no sideways scroll and no
  page errors (13/13). With PV-29's build the first run failed: no live refresh (PV-30's fix).
- PV-35 stage (2026-11-28): share links over HTTP, 13/13. A folder link lists only what's under it (not the sibling
  `/tripod`) and downloads byte-for-byte; a file outside is 404; a password link refuses a wrong password, sets a
  path-scoped HttpOnly cookie on the right one, allows its one download and refuses the second (410). After a revoke
  the very next request was 404 (2.2 s for the DELETE plus the GET).
- PV-34: the Cloudflare API shows prod media-worker and serve-worker with PUBLIC_SHARING=off, stage on.
- PV-36 stage (2026-11-28): an upload link over HTTP, 7/7. The guest form (no script) took notes.txt and refused
  tool.exe (type not accepted, with the reason); the file reached the Review tab held as `review:upload_link`,
  uploaded by `upl_…`; approving made it private; the link counted 1 file and 400 bytes; revoked, the page was 404.
- PV-37 stage (2026-11-28): a public gallery over HTTP, 6/6. A collection with a public and a private file, marked as
  a gallery: the page listed the public file and not the private one, with no script and a deny-all CSP; turned off,
  it was 404.
- PV-39 stage (2026-11-28): a comment mentioning a guest viewer queued one `media.comment_mention` notification
  (category product, idempotency key per comment and person). Its delivery failed: the sender is on the placeholder
  domain `mail.pixvault.example.com`, which the account doesn't own (G92).
- PV-40 stage (2026-11-28, this branch's build served in place of the app): 10/10. A comment (plain text), a file
  shared with the new link shown once and opened by a guest, an upload link for a new folder opened by a guest, a
  collection made from the bulk bar showing its file, and its gallery switched on; no page errors.
- PV6 on the deployed stage app (2026-11-28, after deploys resumed): 11/11 with no page errors. A comment (plain
  text); a file shared and the link opened by a guest; an upload link for a new folder opened by a guest; a collection
  from the bulk bar with its gallery switched on; the Activity tab listing the upload, the comment and the collection.
- Deploy credentials (2026-11-28): Orunbase refused the Cloudflare token for every deploy job from 05:32Z to about
  08:30Z (`broker: limit_reached`, 200 mints per rolling 24 h); retries succeeded once older mints aged out.
- Pre-existing baseline failure: `tests/integrations-worker`, 5 drain tests failing on a clean `main`. Not PV's; follow-up.

- PV7 storage-worker (PV-44, 2026-11-28): internal-only Worker holding BYO credentials sealed under `STORAGE_KEK` (generated in CI). Tested against s3rver: 21 tests incl. tenancy, SSRF refusals, checksum and timeout. Not wired in until PV-45.

## Open risks and deferred items

See `specs/epics/pixvault-team-media/risks-and-open-questions.md` and [`WAITING.md`](../../WAITING.md) (W-1 … W-9).

## Pointers

- As built: `specs/epics/pixvault-team-media/IMPLEMENTATION-STATUS.md`
- Port inventory: `specs/epics/pixvault-team-media/port/README.md`
