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

_Last updated: 2026-11-27, after PV2 (PRs #3–#15)._

## Blocked

| # | Item | Why | What's missing | What was done | Lands |
|---|---|---|---|---|---|
| G1 | **Cloudflare scopes for Queues and custom hostnames** (WAITING W-3) | Orunbase's Cloudflare scope templates mint only Workers, KV, R2, D1 and DNS tokens. There's no template for Queues Write, SSL and Certificates Write, or Zone Settings Write. | PV4's `file-committed` queue and DLQ; PV8's custom domains; Image Transformations on our own zone. | Recorded with exact steps. Raised to the user, who needs to decide on a platform change in orun-cloud (`apps/integrations-worker/src/providers/cloudflare.ts`). PV4 can use Workflows (deployable today) until Queues are mintable. | PV4 and PV8, after the decision |
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
| G16 | **Index outbox** (DO → KV routes, queue jobs, events) | §1.3 | PV2 had no consumer: serving (PV3) is the first. | Nothing reads committed files outside the index yet. | **PV3** (serving needs the KV routes) |
| G17 | **Nightly index export to R2, and a restore drill** | §1.3, risk PV-C | Not needed for function. Deferred to keep PV2 to its acceptance list. | **No backup of a library's metadata beyond the Durable Object's own durability.** | PV5 (with the restore drill) |
| G18 | **DO size alarm at 70%** | §1.3 | Libraries are far from 10 GB of metadata. | No early warning. | PV10 (imports are the first big writers) |
| G19 | **URL upload** (`functions/api/fetchRes.js`, IB-032) | §6 screen 2 | Needs an SSRF guard (no private ranges, a size cap); not on PV2's acceptance list. | You can't paste a URL to upload. | PV5 |
| G20 | **File expiry ("expires at")** (`functions/api/manage/expiry.js`, IB-052) | §4.4 | It goes with the purge Workflows. | No per-file expiry. | PV4 |
| G21 | **Folder upload** (`directoryTraversal.js`, IH-095) | §6 screen 2 | Needs the folder tree UI. | Dropping a folder uploads nothing (files only). | PV5 |
| G22 | **Link formats** (URL, Markdown, HTML, BBCode; `urlBuilder.js`, IH-098) | §6 screen 2 | There are no public or signed URLs until serving exists. | After uploading, there's no link to copy, only Download. | **PV3** |
| G23 | **Upload history and the upload settings dialog** (IH-057, IH-058) | §6 screen 2 | Not on PV2's acceptance list. | No per-user history panel or naming options. | PV5 |
| G24 | **Image compression and format conversion before upload** (`fileFormat.js`, `animatedImage.js`, `FileFormatSettings.vue`) | ImgBed client options | Server-side transforms (PV3) cover most of the need. | No client-side compression or WebP conversion. | PV9 (with the ImgBed-compatible options) |
| G25 | **Version history in the app** | §6 screen 4 (file drawer) | The API exists (`GET …/versions`, `POST …/versions/{n}/restore`); the drawer is PV5. | Versions can be restored only through the API. | PV5 |
| G26 | **Webhook and activity events per file** (`file.uploaded`, …) | §4.7, §4.8 | Library-level actions are audited, but per-file events need the outbox (G16). | No webhooks and no file activity yet. | PV3 (outbox), PV5 (activity) |
| G27 | **Library settings enforcement**: referrer and IP rules, random API toggle | §2.5 | Stored and validated since PV1; serving enforces them. | Settings have no effect yet. | **PV3** |
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
| G43 | **Only media-worker sends logs** | Other workers fail silently. | Workers Logs on media-worker (PV-12). | Turn on observability fleet-wide (a baseline change) |

## Closed

| # | Item | Closed by |
|---|---|---|
| — | Workers Paid plan unknown (W-4) | Measured: a 200 MB commit hashes in one request (PV2, #15) |
| — | Commits over ~128 MB ran out of memory | PV-13, #14 |
| — | Deployed app rendered blank under its CSP | PV-8, #10 |
| — | First deploy of a new workers.dev host failed its smoke test | PV-7, #9 |
| — | Team names whose slug was taken blocked onboarding | PV-6, #8 |
