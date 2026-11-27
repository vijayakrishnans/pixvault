# pixvault-team-media (PV): implementation status

As-built ≠ intent. This file records what actually shipped and every place the code departed from `design.md`.
What *isn't* built, or is blocked, is tracked item by item in [`GAPS.md`](GAPS.md).

| Milestone | State | PR |
|---|---|---|
| PV0: the spec | ✅ done 2026-11-27: PV-1 doc set + port inventory; PV-2 public, listing-ready repo; PV-3 WAITING.md | #3 (`0ca8a26`), #4 (`213d751`), PV-3 (this PR) |
| PV1: libraries and access | ✅ done 2026-11-27: PV-4 backend (libraries, roles, guests, media-worker, facade; 1,200-case matrix; isolation sweep); PV-5 multi-tenant profile; PV-6 media-web app shell and brand check. Verified live on stage | #6 (`dc41aa6`), #7 (`df92dc9`), #8 (`e34ecfc`), #9 (`d932ebf`), PV-8 CSP fix (this PR) |
| PV2: index, storage, uploads | ✅ done 2026-11-27: PV-9 R2 bucket; PV-10 LibraryIndex DO, streamed multipart uploads, dedup, versions, trash, quotas; PV-12 Workers Logs; PV-13 streamed commit hash; PV-11 upload page. Stage acceptance 14/14 incl. 2 GB | #11, #12 (`74c78e5`), #13, #14 (`c4de4c4`), PV-11 (this PR) |
| PV3: serving | ✅ done 2026-11-27: PV-14 gaps register and path correction; PV-15 routes KV (own root); PV-16 serving data plane; PV-17 serve-worker; PV-18 and PV-19 smoke and Server-Timing; PV-20 links in the app | #16, #17, #18, #19, #20, #21, PV-20 (this PR) |
| PV4: pipeline and safety | in progress: PV-22 ProcessFileWorkflow, location removal, held failures and replay; PV-23 moderation, tags, review queue; PV-24 moderation answer shape; PV-25 abuse reports, takedown, suspension, runbook | #24, #25, #26, PV-25 (this PR) |
| PV5: browser and live collaboration | | |
| PV6: sharing | | |
| PV7: BYO storage | | |
| PV8: custom domains | | |
| PV9: developer surface | | |
| PV10: import | | |
| PV11: prod and launch | | |

## Departures from the design

### PV0

- **Account and Cloudflare connection.** The brief named account `openproduct-sms84q22` and the `nexo` connection.
  The workspace lives in `openproduct-6ny98czp` (the user's choice) on its active Cloudflare connection, because
  `nexo` is revoked there (WAITING W-8).
- **Baseline.** Built on `cirrus-baseline` v29 because `cirrus` is retired (PV-J).
- **No `orun/compliance` check** is posted on this repository; the pen is kept by hand and `orun task check` runs
  before every push.
- **Cloudflare scopes.** Queues and custom hostnames can't be minted by Orunbase today (WAITING W-3). PV4's queue
  and PV8 wait on it.

### PV1

- **The baseline shipped in the Solo (single-user) profile.** It allowed one personal org per account and 404'd
  org members, invitations and API keys at the edge. A teams product needs all of them, so PV-5 turns Solo off in
  api-edge, identity-worker, membership-worker and the console. A side effect: new accounts no longer get a
  personal org automatically, and they create their team org through the console's onboarding. The PV1 stage
  smoke caught this on its first run (`403 solo_profile` on a second org).

- **Org role names.** The brief's org "member" is Cirrus's `builder`. `billing_admin` has no library access.
- **`everyone_in_org`** grants org builders `editor` and org viewers `viewer`. The brief didn't say which role.
- **Guests join by email invitation**, accepted on sign-in when the verified email matches
  (`POST /v1/media/invitations/accept`). There's no identity lookup by email to add a guest directly. PV1 sends no
  invitation email: the manager shares the app link, and email delivery arrives with PV6's notifications.
- **Default library.** It isn't created inside Cirrus's org-creation transaction (that would change
  membership-worker). The app creates "Library" on an owner's first visit to an org with none (PV-5).
- **Archiving a library** archives its Cirrus project best-effort. A library manager who isn't an org owner or
  admin lacks `project.delete`, so the project stays active until an admin archives it. The library is hidden
  either way.
- **Listing** asks policy-worker once per library (parallel). That's fine at tens of libraries per org; a batch
  endpoint is a later optimisation.
- **The app is built with Vite**, not ImgHub's Vue CLI, and uses Element Plus icons only (Font Awesome dropped).
  Ported files keep their upstream names and derivation headers. `tests/media-web` checks both against the port
  inventory.
- **A separate session from the console.** The console keeps its bearer token in its own origin's storage (and
  ships as a prebuilt artifact), so the app signs in with the same Cirrus identity (email code) and holds its own
  token. Same account, same orgs, two sign-ins. A shared-session handoff is a later improvement.
- **Team onboarding** retries with a suffixed slug when the name's slug is taken; org slugs are unique across the
  service. The headless browser run found this.
- **At 390 px**, the members and invitations tables scroll sideways inside their cards. Every control is reachable.
- **First deploy of media-web (#8)** uploaded fine, but its smoke ran 0.2 s later, while the new workers.dev host
  still answered 404, on stage and then on prod. Both hosts served the app moments later. PV-7 makes the smoke
  retry for up to 30 s, and its merge's convergence is the green record.
- **The deployed app rendered blank (#8, #9).** The Worker's CSP (`script-src 'self'`, no `unsafe-eval`) blocked
  vue-i18n's runtime message compiler (`new Function`). The local dev server sends no CSP, so the pre-merge
  browser run passed, and the smoke only checked HTML. PV-8 enables vue-i18n's JIT (AST) compilation and makes the
  build fail on `new Function` or `eval(` in any shipped script. The browser flow now runs against the Worker
  (`wrangler dev`) and the deployed stage app, not just the dev server.
- **Accessibility in CI (axe) is not in PV1.** Forms use labels, buttons are buttons, focus is visible, and
  keyboard flow works in the browser run. axe joins the CI lanes with the browse UI (PV5) and is required by PV11.

### PV2

- **Managed R2 uploads stream through media-worker, not presigned URLs.** Presigning needs long-lived S3 keys in a
  Worker (another stored credential) and a bucket CORS rule the pinned Terraform provider can't express. Each part
  (32 MiB) is streamed through media-worker into R2 multipart over the binding instead. It keeps the same session,
  part, commit and resume model, holds no credential, and the bytes stay on Cloudflare's network. Presigning
  arrives in PV7 for BYO buckets, where the keys are the customer's.
- **No separate storage-worker yet.** The `ObjectStore` functions live in `apps/media-worker/src/storage/` and use
  the binding. storage-worker splits out in PV7, where BYO credentials must be decrypted only inside it.
- **Objects are keyed by upload, not by hash** (`org/<org>/lib/<lib>/blob/<ups_id>`, recorded in the index's
  `blobs` table). An upload therefore never overwrites a blob, even when a client declares someone else's hash.
  Dedup is decided after the bytes are verified, and a redundant copy is deleted.
- **The dedup shortcut** (create a file without sending bytes) is allowed only to callers who may read the
  library's files. An uploader who knows a hash must still send the bytes, or the hash alone would unlock them.
- **Quotas are enforced in media's own tables** (`210_media_usage`: stored bytes, monthly uploads, per-org
  overrides), not Cirrus metering. Metering's record and check routes need `organization.metering.*`
  (owner/admin), which an editor's or guest's upload doesn't have. Mirroring usage into metering needs a service
  path in metering-worker; it's a follow-up, recorded in risks (PV-L). Defaults: 10 GiB stored, 2,000
  uploads/month, 2 GiB per file.
- **Measured on stage (2026-11-27, from WSL in India, ~3.3 MB/s uplink):**
  - 2 GB in 60 parts uploads in about 600 s and takes **87 s to verify and index** (risk PV-M: within limits; watch
    it as sizes grow);
  - 200 MB: 7 parts, 11.7 s commit;
  - DO commit throughput: **5.4 commits/s** at concurrency 10 (p50 1.7 s, p95 2.4 s end to end).

  Most of each request's latency is D1. A single D1 query costs about 250 ms from this edge; Cirrus's own
  `GET projects` shows `db;dur=251`. Listing through the index is about 350 ms total. Follow-ups: record usage off
  the response path, merge index lookups, D1 read replication.
- **The first stage run failed every commit above about 128 MB** with "Memory limit would be exceeded before EOF".
  The streaming digest was looked up as a global, but workerd exposes it as `crypto.DigestStream`, so commits
  took a buffered fallback meant for tests. A 70 MB file fit, and local workerd doesn't enforce the memory limit,
  so neither caught it. Workers Logs (PV-12) named it. PV-13 uses `crypto.DigestStream`, and the fallback now
  refuses more than 64 MiB.

### PV3

- **Routes KV in its own root** (`cloudflare-kv-media`), not the existing `cloudflare-kv`. The brokered
  `workers-deploy` token can create KV namespaces but can't read them, so changing an existing KV root fails on
  refresh (GAPS G44).
- **Signing keys are per-library random keys in D1, published with the library map**, not derived from a
  secret-store root (GAPS G45).
- **Serving paths carry the org slug** (`/<orgSlug>/<libSlug>/<path>`), captured at library creation (G13, G46).
- **Presets instead of arbitrary sizes** for transforms (GAPS G49), and **workers.dev** as the serving host until a
  custom domain is possible (G48).

### PV4

- **Workflows instead of Queues** (the user's decision, 2026-11-27): Orunbase can't mint a Queues scope (W-3). A
  failed run holds the file and records a row in `media_pipeline_failures`; a replay endpoint and a sweep replace
  the dead-letter queue (GAPS G56).
- **Cleaning swaps the blob**: the uploaded bytes are verified against the client's SHA-256, then the pipeline writes
  a cleaned copy under its own SHA-256 and moves the file's current version to it (dedup and refcounts apply).
- **Moderation with Workers AI, inside the account** (upstream used third-party services). Only public files on a
  free plan are moderated; an unclear answer holds the file, and a person decides in the review queue (GAPS G61–G64).
- **Abuse cases reuse PV1's `media_abuse_cases`** (migration 240 extends it) instead of a new table; platform
  operators live in `platform_media_operators`, outside the `media_` tenancy rule (GAPS G65).
