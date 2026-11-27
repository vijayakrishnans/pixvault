# pixvault-team-media: gaps register

What isn't built yet, what was built differently from `design.md`, and what's blocked. Each item says **why**,
**what's missing** (the user-visible or operational consequence), **what was done instead** and **where it
lands**. This file is the honest view. `IMPLEMENTATION-STATUS.md` records what shipped; this records what didn't.

It's updated in every PR that opens, changes or closes a gap. A closed gap moves to *Closed* with the PR that
closed it, so the history stays readable.

Status words:
- **Blocked**: needs a person or a platform change.
- **Differently**: shipped, but not as designed.
- **Deferred**: planned for a later milestone.
- **Missing**: in the design for a milestone that's already closed, and not built.
- **Partial**: some of it shipped.
- **Known issue**: a defect or weakness accepted for now.

_Last updated: 2026-11-28, PV-23._

## Blocked

| # | Item | Why | What's missing | What was done | Lands |
|---|---|---|---|---|---|
| G1 | **Cloudflare scopes for Queues and custom hostnames** (WAITING W-3) | Orunbase's Cloudflare scope templates mint only Workers, KV, R2, D1 and DNS tokens. There's no template for Queues Write, SSL and Certificates Write, or Zone Settings Write, and `workers-deploy` lacks KV Read (G44). | PV4's `file-committed` queue and DLQ; PV8's custom domains; Image Transformations on our own zone. | Recorded with exact steps. Raised to the user, who needs to decide on a platform change in orun-cloud (`apps/integrations-worker/src/providers/cloudflare.ts`). PV4 can use Workflows (deployable today) until Queues are mintable. | PV4 and PV8, after the decision |
| G2 | **CSAM scanning** (W-5) | It's enabled per zone in the Cloudflare dashboard and isn't available on `workers.dev`. | No CSAM scanning on any serving host. | **Public sharing stays off in prod** until W-5 and W-6 are done (risk PV-A). | PV4 / PV8 |
| G3 | **Product domain `pixvault.app`** (W-6) | It isn't registered, and there's no zone. | Everything is served on `*.vijayakrishnan12994.workers.dev`: no `i.`/`app.`/`dav.` hosts, and no CSAM scanning (G2). | `productdomain` was left empty at bootstrap; the parked custom-domain component can be switched on later. | When the domain exists |
| G4 | **Grievance officer details and legal review** (W-1, W-2) | They need a person and a lawyer. | `ABUSE.md` has a placeholder section; terms and privacy pages aren't written. | Policy text and process are in `ABUSE.md`. | PV11 |
| G5 | **BYO test bucket** (W-7) and **Docker for MinIO** (W-9) | Credentials and a local daemon. | No end-to-end BYO test against a real S3 endpoint yet. | — | PV7 |
| G6 | **`nexo` connection and the `openproduct-sms84q22` account** (W-8) | `nexo` is revoked on `openproduct-6ny98czp`, and the brief's account gives this login no account role. | Pixvault runs on the user's own Cloudflare account, not Nexo's. | The user chose `openproduct-6ny98czp`; the active connection `int_4da71819…` is used. Moving to Nexo is a redeploy, not a code change. | If the user asks |

## Done differently

| # | Design said | Built | Why | What's missing | Lands |
|---|---|---|---|---|---|
| G7 | **Presigned direct-to-storage uploads** (§4.4) | Each 32 MiB part streams **through media-worker** into R2 multipart over the binding. | Presigning needs long-lived S3 keys inside a Worker, plus a bucket CORS rule the pinned Terraform provider (v4) can't express. | Upload bytes pass through a Worker (no egress cost, still on Cloudflare's network). Each part counts against Worker request limits; 32 MiB is well inside 100 MB. | Presigning arrives with BYO buckets in PV7 |
| G8 | **A separate storage-worker** (§0, §4.4) | `ObjectStore` functions inside media-worker (`src/storage/`). | Nothing needed the isolation yet: managed R2 has no credential. | BYO credentials must be decrypted only in storage-worker. | PV7 |
| G9 | **Quotas through Cirrus metering** (§4.4) | `media_usage` and `media_org_limits` tables (migration 210), enforced by media-worker. | Metering's record and check routes need `organization.metering.*` (owner/admin), and an editor's or guest's upload has neither. | **Media usage isn't visible in the console's usage page or billing** (risk PV-L). | A service-only record route in metering-worker, before PV11 |
| G10 | **Objects keyed `…/blob/<sha256>`** (§1.4) | Keyed by upload, `…/blob/<ups_id>`; the index's `blobs` table maps hash to key. | A client declaring someone else's hash could otherwise overwrite a blob before verification. | Nothing user-visible. | Final |
| G11 | **The default library is created with the org** (§1.1) | The app creates "Library" on the first visit by someone allowed to create. | Creating it inside Cirrus's org transaction would mean changing membership-worker. | An org created through the API has no library until someone opens it in the app. | Acceptable; revisit with PV9 (API users) |
| G12 | **One session shared with the console** (§3) | Same Cirrus identity, but a separate sign-in. | The console keeps its token in its own origin's storage and ships prebuilt. | Users sign in twice (console and app). | A token handoff, PV11 |
| G13 | **Serving at `i.<domain>/<libSlug>/<path>`** (§2.5) | Changed in this PR to `/<orgSlug>/<libSlug>/<path>`. | Library slugs are unique only within an org, so two teams' libraries would share a path. | — | PV3 |
| G14 | **Org role "member"** (§1.1) | Cirrus's `builder`; `billing_admin` has no library access. | Cirrus's role names. | — | Final |
| G15 | **Solo profile** | Turned off (PV-5). | The baseline shipped single-user; teams need orgs, members and invitations. | New accounts get no automatic personal org; they create a team on onboarding. | Final |

## Missing (in the design for a closed milestone, not built)

| # | Item | Design | Why not yet | What's missing | Lands |
|---|---|---|---|---|---|
| G16 | **Index outbox** (DO → KV routes, queue jobs, events) | §1.3 | Built in PV-16 for **KV routes** (put on commit, replace, restore, version restore and visibility; delete on trash). Queue jobs and events aren't produced yet. | Nothing outside the index learns about file changes except serving. | Queue jobs PV4; events PV5 |
| G17 | **Nightly index export to R2, and a restore drill** | §1.3, risk PV-C | Not needed for function. Deferred to keep PV2 to its acceptance list. | **No backup of a library's metadata beyond the Durable Object's own durability.** | PV5 (with the restore drill) |
| G18 | **DO size alarm at 70%** | §1.3 | Libraries are far from 10 GB of metadata. | No early warning. | PV10 (imports are the first big writers) |
| G19 | **URL upload** (`functions/api/fetchRes.js`, IB-032) | §6 screen 2 | Needs an SSRF guard (no private ranges, a size cap); not on PV2's acceptance list. | You can't paste a URL to upload. | PV5 |
| G20 | **File expiry ("expires at")** (`functions/api/manage/expiry.js`, IB-052) | §4.4 | It goes with the purge Workflows. | No per-file expiry. | PV4 |
| G21 | **Folder upload** (`directoryTraversal.js`, IH-095) | §6 screen 2 | Needs the folder tree UI. | Dropping a folder uploads nothing (files only). | PV5 |
| G22 | **Link formats** (URL, Markdown, HTML, BBCode; `urlBuilder.js`, IH-098) | §6 screen 2 | **Built in PV-20**: a Links dialog per file with all four formats, each escaped for its format (upstream inserted names raw), images embedded and other files linked; signed links (1 h, 1 day, 7 days) for private files; a public/private switch for editors and managers. | No custom link prefix (upstream `rootUrl`), and the upload queue doesn't show links (open them from the file list). | Custom domains PV10; queue links PV5 |
| G23 | **Upload history and the upload settings dialog** (IH-057, IH-058) | §6 screen 2 | Not on PV2's acceptance list. | No per-user history panel or naming options. | PV5 |
| G24 | **Image compression and format conversion before upload** (`fileFormat.js`, `animatedImage.js`, `FileFormatSettings.vue`) | ImgBed client options | Server-side transforms (PV3) cover most of the need. | No client-side compression or WebP conversion. | PV9 (with the ImgBed-compatible options) |
| G25 | **Version history in the app** | §6 screen 4 (file drawer) | The API exists (`GET …/versions`, `POST …/versions/{n}/restore`); the drawer is PV5. | Versions can be restored only through the API. | PV5 |
| G26 | **Webhook and activity events per file** (`file.uploaded`, …) | §4.7, §4.8 | Library-level actions are audited, but per-file events need the outbox (G16). | No webhooks and no file activity yet. | PV3 (outbox), PV5 (activity) |
| G27 | **Library settings enforcement**: referrer and IP rules, random API toggle | §2.5 | **Enforced by serve-worker in PV-17**: referrer allow list (subdomains included; direct visits allowed), IP allow and block lists (exact IPv4/IPv6, IPv4 CIDR), the random API toggle and the preset list. | IPv6 CIDR ranges aren't matched, only exact IPv6 addresses. Direct visits with no Referer are always allowed (the upstream behaviour too). | IPv6 CIDR: PV11 |
| G28 | **Blocked executable types for free orgs** | §4.9 | Part of the safety pipeline. | Any MIME type can be uploaded unless the library restricts types. | PV4 |

## Partial

| # | Item | What shipped | What's missing | Lands |
|---|---|---|---|---|
| G29 | **ImgBed upload port** (`functions/upload/*`, IB-079 to IB-086) | Sessions, parts, resume and commit. | The ImgBed request and response shape (`POST /upload`, `authCode`, chunked variants) for PicGo, ShareX and satellite. | PV9 |
| G30 | **ImgHub upload UI** (`UploadForm.vue`, `UploadFileItem.vue`) | Drop, paste, pick, a progress queue, resume, replace and retry. | Link formats (G22), history and settings (G23), compression (G24), URL and folder upload (G19, G21). | PV3 to PV9 |
| G31 | **ImgHub system settings** (`SysCog*`, `SysConfigTabs`) | General, upload rules, access rules, members. | Storage and domain tabs. | PV7, PV8 |
| G32 | **ImgBed schema** (`database/*`, IB-002 to IB-004) | The control tables and the index schema. | Tags and expiry columns. | PV5 (tags), PV4 (expiry) |
| G33 | **Usage page** | A storage bar on the library page. | Uploads, transforms, bandwidth and views per library. | PV3 (Analytics Engine), PV11 |

## Known issues

| # | Issue | Impact | What was done | Next |
|---|---|---|---|---|
| G34 | **About 250 ms per D1 query from the stage edge** | API calls take 0.3–2 s; an upload commit about 1.7 s (p50). | Measured and recorded (ledger). Index reads are fast (~350 ms total). | Record usage off the response path (`waitUntil`), merge index lookups, D1 read replication (Sessions API) |
| G35 | **Library listing asks policy once per library** | Slower lists for orgs with many libraries. | Parallel calls. | A batch decision route in policy-worker |
| G36 | **Archiving a library archives its project best-effort** | A manager who isn't an org admin leaves the project active. | The library is hidden either way. | An admin-side sweep, PV11 |
| G37 | **2 GB commits take ~87 s to verify** | A long-running request (within limits). | Streamed through `crypto.DigestStream` (PV-13). | If it nears limits: per-part checksums plus an asynchronous whole-file check (risk PV-M) |
| G38 | **Members and invitations tables scroll sideways at 390 px** | Usable but cramped on phones. | Every control stays reachable. | PV5 (responsive tables) |
| G39 | **No accessibility checks in CI (axe)** | WCAG 2.2 AA isn't enforced. | Labelled forms, real buttons, visible focus, keyboard flow checked in browser runs. | PV5 and PV11 |
| G40 | **Guest invitations send no email** | The manager shares the app link by hand. | The invitation is created and accepted on sign-in by email match. | PV6 (notifications) |
| G41 | **Baseline test failures**: `tests/integrations-worker` (5 drain tests, also failing on clean `main`); an api-edge rate-limit DO test flaky under full parallel load | Noise in local full runs. CI's PR lanes don't run them. | Verified both against clean `main` and in isolation. | Report upstream to cirrus-baseline |
| G42 | **No `orun/compliance` check is posted on this repo** | Lineage isn't enforced by CI. | Branch, trailer, manifest and contract are kept by hand; `orun task check` runs before every push. | Check the repo link's compliance mode in the console |
| G44 | **The `workers-deploy` token can create KV namespaces but not read them** | Changing an existing KV root fails on refresh with "Authentication error (10000)" (found by PV-15's plan on `cloudflare-kv`). The template grants Workers KV Storage *Write* only; Cloudflare's permission-group API doesn't imply Read. Every product from this baseline is affected. | PV3's routes namespace went into a **new root**, `cloudflare-kv-media` (a fresh root only creates). The same root will hit this on its first later change. | Add Workers KV Storage Read to `workers-deploy` in orun-cloud: added to the W-3 platform decision |
| G45 | **Signing keys live in D1 and the routes KV, not a secret store** | Anyone with read access to the stage/prod D1 or the routes namespace could forge signed URLs for that library. Both are reachable only by bound Workers and Cloudflare account admins. | Per-library random 32-byte keys (migration 220), never in API responses (tested); versioned so they can rotate. Writing keys through the Orunbase secret store is a secret-store write, which agents are blocked from. | Wrap them with a root key from the secret store (the user sets one value), PV11 |
| G46 | **An org slug captured at library creation won't follow an org rename** | Renaming an org would leave its libraries serving under the old slug, and new links would differ from old ones. | Captured once (`media_libraries.org_slug`). Cirrus has no org-rename UI in this product yet. | Re-publish maps on rename and keep the old slug as a redirect, PV11 |
| G47 | **No key-rotation API** | Signing keys can't be rotated yet. | The signature format carries the key version (`<v>.<mac>`), and maps hold keys by version, so rotation is additive. | PV6 (sharing) |
| G48 | **Public serving is on workers.dev, not `i.<domain>`** | Links look like `pixvault-serve-worker-<env>.<sub>.workers.dev/<org>/<lib>/<path>`; changing host later breaks every link already shared. | serve-worker deploys with `workers_dev: true`. A custom domain needs a zone and Zone Settings/SSL scope the brokered tokens don't have (W-3). | Attach a custom domain once W-3 is decided; keep workers.dev answering with redirects, PV10 |
| G49 | **Presets only; no arbitrary width/height/quality** | ImgBed accepts any `w`/`h` up to 4096. Pixvault accepts only the library's presets (thumb 200², small 480, medium 960, large 1920). | Deliberate (risk PV-B): arbitrary sizes let anyone mint unbounded unique transforms on a public URL. | Per-library custom presets in settings, PV9 |
| G50 | **Visibility changes and trash reach serving only as fast as KV's edge cache** | **Measured on stage: a switch to public served after 51 s** at an edge that had just read the private route. The other direction is the one that matters: a file made private or trashed can keep serving publicly for about as long at an edge that recently served it. KV has no global purge. | PV-21: route and map reads use KV's minimum `cacheTtl` (30 s, was 60), the isolate keeps maps 15 s, and the Links dialog says changes can take up to a minute. The edge cache is keyed by the bytes' hash and read only after the route, so it adds nothing. | Takedown needs an immediate path: a DO-checked deny list for held or removed files on the serve path, PV4 (moderation) |
| G51 | **No serving analytics in the app yet** | Data points are written (library, file, referrer host, country, preset, outcome, bytes; no IP), but nothing reads them. | Reading Analytics Engine needs the SQL API with an Account Analytics Read token, which the brokered templates don't include. | Add the scope (W-3) and a usage page, PV11 (G33) |
| G52 | **`cloudflare-worker-turbo` gives the smoke step no URL or environment name** | PV-17's first deploy succeeded but its smoke failed (`DEPLOYED_URL: unbound variable`): only `cloudflare-workers-assets-turbo` sets it, and parameters aren't rendered with the environment. | serve-worker sets `SERVE_URL` per environment under `subscribe.environments[].env` (the plan puts it in the job's env), and the smoke reads it. CI also runs the smoke **once** (prod's first deploy failed in 0.3 s on the new route's 404 window), so the smoke retries for 30 s itself (PV-19). | Upstream: export `DEPLOYED_URL` from the worker type too (orun-cloud compositions) |
| G53 | **No latency measurement from a well-connected client** | From the build box, `/health` alone has p95 over 300 ms and some connections time out, so client TTFB says nothing about the worker. | Every response carries `Server-Timing: worker;dur=…` (the worker's own I/O time), and the PV3 latency criterion is measured from it. | A synthetic check from a cloud runner near an edge (Cloudflare Health Checks or a scheduled CI probe), PV11 |
| G54 | **No `serve_routes` D1 mirror** | Design §2.5 keeps a D1 copy of every route so KV can be rebuilt. | Each library's index is already the source: `requeueAllRoutes` re-publishes every live file's route (used for pre-PV3 libraries). A D1 mirror would be a third copy and cost ~250 ms per write (G34). | Add an admin "rebuild routes" action that walks libraries and calls `requeueAllRoutes`, PV11 |
| G55 | **No blocked list (451)** | Serving has no per-file block that answers 451 Unavailable For Legal Reasons. | Held and flagged files already return 404; the 451 path belongs with moderation and takedown. | PV4 |
| G56 | **Workflows instead of Queues (decided by the user, 2026-11-27)** | Design §4.3 has Queues with a dead-letter queue. Orunbase can't mint a Queues scope (W-3). | `ProcessFileWorkflow`: each step retries on its own (3 times, exponential); a run that still fails **holds** the file and writes a row to `media_pipeline_failures` (the dead-letter list); `POST …/files/{fil}/reprocess` replays it; the index sweeps files still processing after 10 minutes and starts a new run. | No platform-wide failure view yet (per-library only), PV-24 with the admin tools. Queues stay possible once W-3 is decided |
| G57 | **Location removal covers JPEG, PNG and WebP only** | HEIC, AVIF, TIFF and GIF keep any location metadata. IPTC location fields (city or country names) and XMP that doesn't mention GPS are kept in JPEGs. Images over 64 MiB are held for a person instead of being cleaned. | JPEG: the GPS IFD is emptied in place (orientation and camera data stay) and XMP mentioning GPS is dropped, and unreadable EXIF is dropped whole; PNG: eXIf and XMP chunks dropped; WebP: EXIF and XMP chunks dropped. Fail closed. | HEIC/AVIF via a decoder or the Images binding's metadata stripping, IPTC, and streaming large JPEGs: PV9 |
| G58 | **No blurhash or stored thumbnails** | The design's pipeline makes a thumbnail and a blurhash. | Thumbnails are served on demand by the preset transforms (PV3), and nothing reads a blurhash until the library browser. | PV5 (library browser) |
| G59 | **"Free plan" means no active or trialing subscription to a priced plan** | Orgs with per-org overrides or a zero-price paid plan count as free. If the plan can't be read, the org is treated as free (the safer side). | `orgIsOnFreePlan` reads `billing_subscriptions` and `billing_plans`. | A plan feature flag for "trusted uploads", PV11 |
| G60 | **Files wait for the pipeline before they are served** | An image is `processing` (404 on its link) for the seconds a run takes, or up to 10 minutes if the run is lost and the sweep restarts it. | Deliberate: an image is never served before its location data is removed. | Measure on stage; a progress indicator in the app, PV5 |
| G61 | **Only images are moderated** | A public non-image on a free plan (a PDF, a video) goes through the pipeline but isn't classified (`moderation: not_applicable`) and is served afterwards. Videos and PDFs could carry unsafe content. | Image moderation covers the brief's main risk (an image host). Video and PDF need frame or page extraction, which the Workers runtime doesn't offer. | Video frames via Stream or a container, PDFs via page rendering: PV9; meanwhile abuse reports and takedown (PV-24) cover them |
| G62 | **Moderation is one model's judgement, with no hash matching** | False positives hold good files (a person approves them); false negatives serve bad ones until reported. There's no known-CSAM hash matching in the pipeline. | Workers AI vision model with a strict JSON contract; anything unclear holds the file; nothing the model says is stored. Cloudflare's CSAM Scanning Tool works on zones, and serving is on workers.dev. | CSAM scanning once serving has a zone (W-5, W-6); an evaluation set of synthetic cases, PV11 |
| G63 | **ImageNet labels as tags; no search over them** | Tags are resnet-50's ImageNet classes (only those it scores ≥ 0.4, at most 3), e.g. "tabby cat", not descriptive keywords. Nothing searches them yet. | A cheap baseline that stays inside the account; tags are stored on the file. | A captioning model for descriptive tags and FTS over names and tags, PV5 |
| G64 | **No notification when a file is flagged or held** | Editors learn about the review queue only by opening it. No `file.flagged` webhook. | The queue is `GET …/files?review=1`. Notifications and webhooks need the events outbox (G26). | PV5 (events), with `file.flagged` |
| G43 | **Only media-worker sends logs** | Other workers fail silently. | Workers Logs on media-worker (PV-12). | Turn on observability fleet-wide (a baseline change) |

## Closed

| # | Item | Closed by |
|---|---|---|
| — | Workers Paid plan unknown (W-4) | Measured: a 200 MB commit hashes in one request (PV2, #15) |
| — | Commits over ~128 MB ran out of memory | PV-13, #14 |
| — | Deployed app rendered blank under its CSP | PV-8, #10 |
| — | First deploy of a new workers.dev host failed its smoke test | PV-7, #9 |
| — | Team names whose slug was taken blocked onboarding | PV-6, #8 |
