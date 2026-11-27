# pixvault-team-media: risks and open questions

Each entry has a letter, a title and a state: **RISK** (open, with a mitigation), **RESOLVED** (decided, with what
and why), **ACCEPTED** (a cost we carry knowingly) or **SETTLED** (decided for now, revisited on a stated cadence).

## PV-A: abuse of a free public image host (RISK, mitigated)

This is the biggest operational risk: free public hosting attracts CSAM, malware, phishing kits and piracy.
Mitigations ship before public sharing is turned on in prod:
- free public uploads are held non-public until `ProcessFileWorkflow`'s safety step passes;
- Cloudflare CSAM scanning on every serving hostname;
- AI moderation per library;
- a report link on every public file, with takedown to 451 in under a minute;
- upload and serving rate limits, and blocked executable types;
- org suspension for repeat offenders;
- a grievance contact.

Matched CSAM is handled by the platform-admin runbook, never by an agent. **Don't turn on public sharing in prod
before PV4 is ✅.**

## PV-B: cost (RISK, mitigated)

Storage, transforms and AI tags cost money per use, and any anonymous URL can be used to run up transform
variants. The mitigations:
- quotas from day one (Cirrus metering), enforced at session creation;
- transform presets instead of arbitrary sizes;
- serving rate limits;
- BYO storage as the way past the free storage quota.

R2, Image Transformations and custom-hostname pricing are re-checked at each milestone that uses them, with the
figures and the date recorded in the ledger.

## PV-C: Durable Object index is a per-library write bottleneck (RISK)

All of a library's writes go through one DO. PV2 measures commit throughput, and PV10 batches import writes
(about 500 rows per transaction). A nightly export plus a restore drill covers loss. A library approaching the
DO size alarm (70%) is split by year-folder, which is designed for but not built.

## PV-D: BYO bucket failures and CORS (RISK, mitigated)

Customer buckets break, rotate credentials or block CORS. The wizard tests put, get, delete and list and prints
the exact CORS rule. A health-check Workflow sets `storage_backends.status`, and a broken backend affects only its
own library (separate circuit, clear status in settings and the app).

## PV-E: upstream behaviour drift (SETTLED; revisit per quarter)

ImgBed moves quickly. The port is specified against `611153e` / `1621525`. A ref is bumped only in its own task,
with the inventory regenerated and the diff reviewed.

## PV-F: compatibility promise (RISK, mitigated)

PicGo, ShareX, uPic and `satellite` configs depend on ImgBed's upload request and response format. Contract tests
pin it, and an incompatible change needs a new versioned endpoint.

## PV-G: a Vue app inside a Cirrus product (ACCEPTED)

The app is Vue 3 + Element Plus while the Cirrus console is Next.js. We accept two front-end stacks to reuse an
MIT UI almost verbatim. The shared session cookie and a common org menu keep navigation consistent.

## PV-H: legal duties (RISK)

India's IT Rules for intermediaries (grievance officer, takedown timelines) and DMCA-style notices from abroad.
The pages and the takedown log are in scope. The grievance officer's details and a legal review are human items
in `WAITING.md`.

## PV-I: brand (RESOLVED)

No ImgBed or Sanyue marks anywhere user-visible. "Cloudflare" is used only nominatively ("runs on Cloudflare").
A CI grep enforces this from PV1. The product name is a working name (`Pixvault`) and can change in one place.

## PV-J: baseline named in the brief is retired (RESOLVED)

The brief names `cirrus`. The registry marks `cirrus` retired at baseline-v13 and names `cirrus-baseline` as its
successor. We build on `cirrus-baseline baseline-v29`, which has the same workers and conventions.

## PV-K: account access for the workspace (RISK, blocking)

On 2026-11-27, creating the `pixvault` workspace under account `ws_SMS84Q22` returned 404 because the building
user has no role on that account. Phase A waits on WAITING W1. Spec and inventory work proceeds meanwhile.
