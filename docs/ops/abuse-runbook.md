# Abuse runbook

How Pixvault's operators handle reports, take files down and suspend teams. Design: `specs/epics/pixvault-team-media/design.md` §4.9.
Status and known limits: `specs/epics/pixvault-team-media/GAPS.md` (G50, G55, G61, G62, G65–G69).

## Who can act

Only **platform operators** can act. They are subject ids in the D1 table `platform_media_operators` of each environment.
The repository is public, so the list is never kept in it. Anyone else calling an admin route gets `404`, including a team's own owner.

To add an operator, a Cloudflare account admin runs this against the environment's database:

```sh
wrangler d1 execute pixvault-<env> --remote --command \
  "INSERT INTO platform_media_operators (subject_id) VALUES ('usr_…')"
```

To remove one, delete the row. Operators act through the API with their normal session (`Authorization: Bearer …`), and every action is audited.

## Where reports come from

- **The report link.** Every file response from serve-worker carries `Link: <…/_report?u=…>; rel="report"`. The form asks for a category, optional details and an optional email.
  - Reports are limited to 5 a minute per IP.
  - One open case per file: repeat reports raise `reportCount`.
- **Moderation.** Free-plan public images that a model flags never reach the public. They wait in each library's review queue for the team's editors (not operators).

## Triage

`GET /v1/media/admin/abuse-cases?status=open` lists open cases. **CSAM reports come first**, then violence, sexual content, hate, harassment, malware, copyright, spam and other.

Each case carries:
- the file's id and name;
- its current status;
- `viewUrl`, a signed link valid for 10 minutes;
- the reporter's category, words and contact.

### CSAM (`category: csam`)

1. **Don't open, download or forward the file.** Take it down at once on the report alone:
   `POST /v1/media/admin/abuse-cases/{abc_…}/takedown {"note":"csam report"}`.
2. Report it to NCMEC (US) or the national hotline, as the operator's legal obligations require. Give the case id and the file id, never the file.
3. Preserve evidence as counsel directs. Taking a file down doesn't delete it; it stays in storage until the team purges it, so **don't purge it**.
4. If the team uploads such material on purpose, **suspend the team** (below).

Cloudflare's CSAM Scanning Tool isn't on yet (WAITING W-5): serving runs on workers.dev, and the tool works on zones.

### Everything else

Open `viewUrl`, decide, then do one of these:
- **take it down:** `POST /v1/media/admin/abuse-cases/{abc_…}/takedown {"note":"…"}`;
- **dismiss it:** `POST /v1/media/admin/abuse-cases/{abc_…}/dismiss {"note":"…"}`.

For copyright, act on a complete notice. Restore with `reinstate` if a valid counter-notice comes in.

## What a takedown does

- The file's status becomes `removed`. serve-worker answers **451** with a notice that says nothing about the file.
- The team can't replace it or restore an older version over it.
- The bytes stay in storage.
- **Timing:** about 20 s at a location that served the file in the last 30 s (KV edge cache, GAPS G50), at once elsewhere. Measured on stage: see the ledger.
- **Undo:** `POST /v1/media/admin/organizations/{org_…}/libraries/{lib_…}/files/{fil_…}/reinstate`.
- **Without a case:** `…/files/{fil_…}/takedown`.

## Suspending a team

```
POST /v1/media/admin/organizations/{org_…}/suspend   {"reason":"…"}
POST /v1/media/admin/organizations/{org_…}/unsuspend
```

Suspension marks every library's serving map, so **every file of the team answers 451**, signed links included. The team can't start uploads (`423`).
Nothing is deleted: lifting the suspension restores serving.

## Failed pipeline runs

`GET /v1/media/admin/pipeline-failures` lists runs that failed after their retries, across every team. The response holds ids and step names only.
The files are held, never served. A team's editors can replay one with `POST …/files/{fil_…}/reprocess`. If many fail at the same step, check Workers Logs for `pixvault-media-worker-<env>`.

## What this runbook doesn't cover yet

| Missing | GAPS | Planned |
|---|---|---|
| An operator UI (API only) | G68 | PV11 |
| Notifying a team that a file was taken down | G66 | PV5 |
| Replying to reporters | G66 | PV5 |
| An appeal flow | G67 | PV11 |
