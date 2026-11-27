# pixvault-team-media: implementation plan

Milestones land in order. Each is one or more tasks under the same Orunbase milestone, each task is one pull
request (`orun/PV-<k>-<slug>`, an `Orun-Task` trailer, a manifest block) and lands only when every check is green.
A milestone is marked ✅ here when its **Done when** list is true, and recorded in `IMPLEMENTATION-STATUS.md` by the
PR that lands its last task. Upstream sources are cited at `CloudFlare-ImgBed@611153e` and `Sanyue-ImgHub@1621525`;
`port/README.md` lists every file.

## PV0: the spec ✅

PV-1 lands this doc set, the task contract and `tools/port-inventory` with its generated `port/*.json`. PV-2 makes
the repo public and ready to list (LICENSE MIT, THIRD_PARTY_NOTICES, SECURITY, CONTRIBUTING, ABUSE, README with the
non-affiliation line, topics, secret scanning, push protection, branch protection). PV-3 records the human items in
`WAITING.md` (grievance officer, `nexo` scopes, the Workers Paid plan, CSAM scanning, the domain).

- **Ported:** none. `tools/port-inventory/inventory.ts` reads both repos at their refs and fails on any file without a decision.
- **Cirrus touched:** none.

**Done when**
- `task_get PV-1` and `task_get PV-2` read `done`
- every ImgBed and ImgHub source has a decision in `port/*.json`
- `gh repo view --json visibility` reads `PUBLIC`

## PV1: libraries and access

This milestone adds migration `200_media_control` (every D1 table in design §1.2), creates a library on a Cirrus
project, adds library roles and guests to `policy-engine`, and adds the `media-worker` skeleton with its `api-edge`
facade (libraries and members). It also adds the `apps/media-web` shell (ImgHub's layout, router and theme)
signed in through Cirrus identity, with the org and library switcher, and the rebrand with a CI brand-mark grep.

- **Ported:** `functions/api/manage/sysConfig/**` becomes library settings. **Replaced:** `functions/api/auth/**`
  and `functions/utils/auth/**` by Cirrus identity, membership and policy, and `apiTokens.js` by Cirrus API keys.
- **Cirrus touched:** `packages/db`, `packages/contracts`, `packages/policy-engine`, `apps/policy-worker`,
  `apps/projects-worker` (default library on org create), `apps/api-edge`, `intent.yaml`.

**Done when**
- the permission matrix (org role × library role × action) passes as a test table
- cross-org and cross-library isolation tests pass on every PV1 table and route (a denied read is 404)
- `pnpm test:brand` finds no ImgBed or Sanyue mark, logo or upstream link in shipped output

## PV2: library index, managed storage and uploads

This milestone adds the `LibraryIndex` DO (SQLite schema from design §1.3, outbox and alarm) and `storage-worker`
(`ObjectStore` with `managed-r2`; presign, multipart, HEAD, copy, delete). It adds upload sessions with presigned
single PUT under 100 MiB and multipart above it, resume, and commit with a size and SHA-256 check. It adds dedup
with refcounts, versions, trash with restore, quota checks at session creation and counting on commit, the expiry
Cron for stale sessions, and the upload page.

- **Adapted:** `functions/upload/**` (`index.js`, `chunkUpload.js`, `chunkMerge.js`, `uploadTools.js`),
  `functions/api/fetchRes.js` (URL upload, with an SSRF guard), `functions/api/manage/{delete/**,expiry.js,dedup/**,quota.js}`, `functions/utils/indexManager.js`, `d1Database.js` and `databaseAdapter.js`
  (replaced by the DO index). `s3Client.js` becomes the BYO store in PV7; managed R2 uses the binding.
- **Cirrus touched:** `packages/contracts`, `apps/metering-worker` (meters), `apps/api-edge`, `infra/` (R2 bucket,
  DO migration).

**Done when**
- end to end on stage: uploads of 1 KB, 10 MB, 200 MB and 2 GB commit with matching hashes
- a multipart upload killed half way resumes from the last part and commits
- uploading the same bytes twice adds no bytes to the bucket (refcount 2)
- delete goes to trash, restore brings back the same file, and purge removes the blob only at refcount 0
- a session over the org's storage or monthly upload quota is refused with `quota_exceeded`
- DO commit throughput is measured and recorded (PV-C)

## PV3: serving

This milestone adds `serve-worker` at `i.<domain>`, the KV route cache filled from the DO outbox (with
`serve_routes` as the rebuild mirror), public serving with immutable caching and ETag, and private files by HMAC
signed URL with per-library rotatable keys. It adds transforms through Image Transformations restricted to
presets, access rules (allowed referrers, IP block and allow lists, per-IP rate limit, blocked list returning 451),
the random-image API and Analytics Engine data points.

- **Adapted:** `functions/file/[[path]].js`, `fileTools.js`, `functions/file/imageTransform.js` (fallback),
  `functions/random/**`, `functions/api/manage/cusConfig/**` (IP lists), `functions/utils/purgeCache.js`,
  `functions/utils/metadata/metadata{Security,View}.js`.
- **Cirrus touched:** `intent.yaml` (new Worker, KV, AE dataset), `packages/contracts`.

**Done when**
- a load test on stage shows p95 TTFB < 100 ms for cached public files (recorded in the ledger)
- an expired, altered or other-library signature returns 404; a valid one returns 200
- a file in library A can't be served through library B's path, slug or domain (test)
- a preset not on the library's list returns 400 and isn't counted

## PV4: pipeline and safety

This milestone adds `ProcessFileWorkflow` (metadata, EXIF GPS strip, thumbnail, blurhash, moderation,
held-until-safe for free public uploads, AI tags, index and FTS update, events), Queues with a DLQ and a replay
tool in platform admin, and the review queue. It adds abuse reports (link plus header), `abuse_cases`, takedown
returning 451 with a notice page, org suspension, and CSAM scanning on serving hostnames.

- **Adapted:** `functions/utils/ai/**`, `functions/api/manage/ai/**`, `functions/api/manage/sysConfig/ai.js`,
  `functions/api/manage/{block,white}/**` (moderation actions), `functions/utils/fileExpiry{Service,Helpers}.js`.
- **Cirrus touched:** `apps/admin-worker` (abuse and DLQ views), `apps/notifications-worker`,
  `apps/webhooks-worker` (`file.flagged`).

**Done when**
- a free-plan public upload returns 404 on its public URL until the safety step passes (test)
- a takedown blocks serving within 1 minute, measured on stage
- `docs/ops/abuse-runbook.md` is on `main`
- GPS EXIF is absent from a stored fixture JPEG by default

## PV5: library browser and live collaboration

This milestone adds folders, grid and list, FTS5 search, filters (type, tag, uploader, date, visibility,
status), bulk actions, the file drawer, and WebSocket live updates and presence through the DO hibernation API.

- **Adapted:** `functions/api/manage/{list.js,move/**,rename/**,metadata/**,tags/**}`,
  `functions/utils/{deleteBatch,tagHelpers,tagService}.js`, `functions/api/directoryTree.js`; ImgHub's
  `AdminDashBoard.vue` and `components/dashboard/**`.

**Done when**
- a two-browser Playwright test shows an upload in one browser appearing in the other within 2 s
- two concurrent moves of the same folder end in one consistent tree
- a bulk move of 1,000 files completes and the index stays consistent

## PV6: sharing

This milestone adds share links (view or download, expiry, password, download limit, open trail), upload links
with review, collections and public gallery pages, comments with mentions and email, and activity per file and
per library.

- **Adapted:** ImgBed's guest-upload idea, `functions/api/public/list.js`; ImgHub's `PublicBrowse.vue`.

**Done when**
- revoking a link makes the next request 404 (no caching of the grant)
- upload-link size, type, count and expiry limits are enforced (tests)
- a guest holding a link sees only the shared target on every route (test)

## PV7: BYO storage

This milestone adds the `s3-compatible` `ObjectStore` (SigV4, any S3 endpoint) and the setup wizard (put, get,
delete and list test, plus the CORS rule). It adds envelope-encrypted credentials, a per-library backend,
managed ↔ BYO migration by Workflow, and health checks.

- **Adapted:** `functions/utils/storage/s3Client.js`.

**Done when**
- end to end against `BYO_TEST_BUCKET_*` (or MinIO locally until the secret exists)
- migration moves every blob, verifies hashes and leaves the index consistent, in both directions
- a broken BYO bucket shows `error` status and other libraries keep serving

## PV8: custom domains

This milestone adds custom hostnames per library through SSL for SaaS: DNS instructions, verification,
certificate status, serving and CSAM scanning on the custom host.

**Done when**
- a test hostname on a zone in the Cloudflare account serves a library's files end to end
- removing the domain stops serving on it

## PV9: developer surface

This milestone adds `/api/v1` with generated OpenAPI, scoped API keys, the ImgBed-compatible `/upload` (and
chunked), WebDAV with per-user app passwords, webhooks, the MCP server, and docs with PicGo, ShareX, uPic and
satellite configs.

- **Adapted:** `functions/upload/index.js` (contract), `functions/dav/**`, `functions/api/manage/apiTokens.js`
  (as key UI).

**Done when**
- contract tests pass for every `/api/v1` endpoint
- each documented client config uploads successfully in an automated test
- WebDAV passes a litmus-style suite for the supported subset

## PV10: import

This milestone adds one-way import from an ImgBed instance (export file or API), Telegram, Discord and Hugging
Face channels via their APIs, and WebDAV and S3 sources, with progress, dedup and a report.

- **Import-only:** `functions/utils/storage/telegramAPI.js`, `discordAPI.js`, `huggingfaceAPI.js`,
  `webdavAPI.js`, `functions/upload/huggingface/**`, `functions/api/channels.js`. **Adapted:** ImgBed's backup
  format (`functions/api/manage/batch/{list,settings}.js`, `batch/restore/**`) as the importer's input.

**Done when**
- importing a generated ImgBed fixture instance reproduces its folders, tags and files
- the import never writes to the source (asserted against a recording fake)

## PV11: prod and launch

This milestone adds prod hardening, the usage page, plans and quotas through Cirrus billing, help docs, the
abuse, terms and privacy pages, and the OpenProduct listing. Public sharing turns on in prod only now, after PV4.

**Done when**
- the prod smoke passes: sign up → invite a teammate → create a library → upload via the app and via the PicGo
  config → share link → custom transform → the teammate comments live → delete and restore

## Sequencing note

PV1 (access) and PV2 (index and storage) come first because every later surface is a reader of the library index
and a client of policy. PV3 (serving) needs the outbox routes from PV2. PV4 (safety) lands before PV6 (sharing) is
turned on in prod (PV-A). PV7 and PV8 extend storage and serving and can follow in either order, but PV7 is first
because migration exercises the `ObjectStore` seam. PV9 wraps the stable resources in public contracts. PV10 needs
PV7's S3 adapter and the batch writes measured in PV2. Each milestone checks its Cloudflare scope (R2, Queues,
DO, Workflows, AI, Images, AE, SSL for SaaS) at its start, and a missing scope goes to `WAITING.md`.
