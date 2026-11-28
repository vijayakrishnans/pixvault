# Waiting on a human

Things Pixvault needs that an agent can't or mustn't do. Each item has exact steps and the signal that unblocks
it. The build loop re-checks every open item at the start of each milestone. Work that doesn't depend on an item
continues meanwhile (local `wrangler dev`, Miniflare, MinIO).

| Id | Item | Blocks | State |
|---|---|---|---|
| W-1 | Grievance officer details (India IT Rules) | PV11 launch; public sharing in prod | ⛔ open |
| W-2 | Legal review of terms, privacy and abuse pages | PV11 launch | ⛔ open |
| W-3 | Cloudflare scopes Orunbase can't mint yet: Queues, custom hostnames, zone settings | PV4 (Queues), PV8 (domains), PV3 transforms on a custom zone | ⛔ open |
| W-4 | Confirm the Cloudflare account is on Workers Paid | PV4 (Queues need Paid) | ✅ confirmed by measurement (PV2) |
| W-5 | Turn on CSAM scanning for the serving hostnames | PV4 done; public sharing in prod | ⛔ open |
| W-6 | Choose and register the product domain (the user picks a unique name later), then add its zone | PV8 on our domain; `i.`/`app.` hosts | ⛔ open |
| W-7 | A throwaway S3-compatible bucket for BYO tests | A real-bucket run of PV7 (s3rver covers the tests) | ⛔ open; enter it in the Storage tab on stage |
| W-8 | The brief's `nexo` Cloudflare connection is revoked on this account | nothing (decision only) | ℹ️ decision |
| W-9 | Docker on the build machine (for MinIO) | PV7 local BYO tests | ⛔ open |

## W-1. Grievance officer details

The India IT Rules require intermediaries to publish a grievance officer's name, contact details and the
complaint process. `ABUSE.md` and the product's abuse page have a placeholder section.

**Steps:** send the officer's name, email address, postal address and working hours. They go into `ABUSE.md` and
the abuse page in PV11.
**Signal:** the details are in this file or in the PV11 task's notes.

## W-2. Legal review

PV11 writes the terms, privacy and abuse pages, covering the India IT Rules and DMCA-style notices from abroad
(risk PV-H).

**Steps:** a lawyer reviews the drafts in PV11's PR before it merges.
**Signal:** an approving review on that PR.

## W-3. Cloudflare scopes Orunbase can't mint yet

Orunbase mints deploy credentials from scope templates (`orun integrations cloudflare templates list`). Today:
`workers-deploy` = Workers Scripts Write + Workers KV Storage Write + Account Settings Read; `r2-data` = Workers R2
Storage Write; `d1-edit` = D1 Write; `dns-edit` = DNS Write (per zone). These cover Workers, Durable Objects,
Workflows, KV, D1 and R2.

**Missing:**
- **Queues Write**, to create the `file-committed` queue and its DLQ (PV4).
- **SSL and Certificates Write** on the product zone, for custom hostnames through Cloudflare for SaaS (PV8).
- **Zone Settings Write** on the product zone, to turn on Image Transformations (PV3, when served from our zone).
  On workers.dev, transforms fall back to the in-Worker transformer recorded in `design.md`.
- **Workers AI** and **Analytics Engine** bindings deploy under Workers Scripts Write; the first PV3 and PV4
  deploys confirm this.

- **Workers KV Storage Read** in `workers-deploy`. It has Write only, which Cloudflare's API doesn't treat as
  Read, so an existing KV root can't be refreshed (GAPS G44; PV-15 worked around it with a new root).

**Steps:** in orun-cloud (`apps/integrations-worker/src/providers/cloudflare.ts`), add templates for these
permission groups (and Read to `workers-deploy`). Then make sure the parent Cloudflare connection's token holds those groups (reconnect with a
wider token if `parent_grant_insufficient`). This is a platform change in another repository, so it waits for a go
from the person who owns orun-cloud.
**Signal:** `orun integrations cloudflare templates list --workspace ws_KG0H9PEH` shows a queues template (and, for
PV8, a custom-hostnames template).

## W-4. Workers Paid plan

Queues need the Workers Paid plan. Durable Objects (SQLite) and Workflows run on Free with lower limits; the Cirrus
fleet already deploys a Durable Object here.

**Steps:** confirm in the Cloudflare dashboard (Workers & Pages → Plans) for the account behind connection
`int_4da71819…`, and upgrade if needed.
**Signal:** the plan reads "Workers Paid".

## W-5. CSAM scanning

Cloudflare's CSAM Scanning Tool is turned on in the dashboard, not through the API, and needs a contact email for
NCMEC notifications.

**Steps:** Cloudflare dashboard → the zone → Caching → Configuration → CSAM Scanning Tool → enable, with the
platform abuse contact. Repeat for every serving zone (`pixvault.app` once it exists). It isn't available on
`workers.dev`, so **public sharing in prod waits for W-5 and W-6.**
**Signal:** the tool shows "Enabled" for the serving zone.

## W-6. Domain `pixvault.app`

The product serves on `*.vijayakrishnan12994.workers.dev` until it has a domain.

**Decision (2026-11-28):** the user will choose the domain later, after looking at some unique names (as was done
for another of their products). Nothing is registered or proposed until then; `pixvault.app` was only a placeholder.
**Steps:** once chosen, register it and add the zone to the Cloudflare account behind `int_4da71819…`.
**Email routing will be done later** (the user's decision, 2026-11-28), with the domain.
Then set notifications-worker's `EMAIL_FROM_ADDRESS` (stage and prod) on that domain and onboard it for Cloudflare Email:
until then no email is delivered (sign-in codes on prod included), because the sender is a placeholder domain (GAPS G92).
**Signal:** the zone is active in that account. The parked custom-domain component is then switched on, routing
`pixvault.app`, `app.`, `i.`, `dav.` and `stage.*`.

## W-7. BYO test bucket

**Steps:** create a throwaway bucket (a second R2 bucket with a scoped token, or Backblaze B2) and store its
endpoint, region, bucket, access key and secret as workspace secrets `BYO_TEST_BUCKET_ENDPOINT`, `…_REGION`,
`…_BUCKET`, `…_ACCESS_KEY_ID`, `…_SECRET_ACCESS_KEY` in `ws_KG0H9PEH`. Never use a production bucket.
**Signal:** `secrets_list` shows the five keys.
**Simpler, since PV-48 (2026-11-28):** create the bucket and a key scoped to it, then enter them yourself in the
stage app: a library's **Settings → Storage → Use your own bucket → Test the bucket**, then **Use this bucket** (or
**Move files to this bucket**). The keys go straight to storage-worker, encrypted; no one needs to see them. Tell the
agent which library, and it verifies uploads, downloads and a migration back from its side.

## W-8. `nexo` is revoked (decision record)

The brief named the `nexo` Cloudflare connection. In account `openproduct-6ny98czp`, which the user chose on
2026-11-27, that connection (`int_9b0c36e8…`) is **revoked**, and the brief forbids reconnecting it. Pixvault runs
on the account's active Cloudflare connection `int_4da71819…`. If it must move to Nexo's account, reconnect `nexo`
on this account and say so; that is a redeploy, not a code change.

## W-9. Docker for local BYO tests

**Steps:** turn on Docker Desktop's WSL integration for the build machine's distro.
**Signal:** `docker version` prints a Server section.
**Status (2026-11-28):** the daemon is up, but image pulls fail here (Docker Hub denied, quay.io 401), and running a downloaded MinIO binary was refused by the agent's safety checks. The S3 client is tested against an in-process S3-compatible server (s3rver) and AWS's published signatures; a real-bucket end-to-end run waits for W-7, or for a MinIO the user starts.
