# OWASP review

What Pixvault has built so far (PV0–PV5), checked against the **OWASP Top 10 (2025)**. Each row gives the
controls in place, where they're tested, and what's still open (GAPS ids in
`specs/epics/pixvault-team-media/GAPS.md`).

- First review: 2026-11-28 (PV-31), after PV5.
- It's updated whenever a task changes an area below. Every task also answers the checklist at the end in its PR.

## Findings fixed in PV-31

| # | Category | Finding | Fix |
|---|---|---|---|
| F1 | A07 Authentication | **Expired email login codes were accepted.** The consume query never checked `expires_at`, and the identity-worker tests used a fake repository that did, so nothing caught it. | The consume query requires `expires_at > now`. A real-SQLite test fails on the old query. |
| F2 | A07 Authentication | **A login code had no wrong-guess limit.** Only the per-IP rate limit (10 a minute) stood in the way, so attempts spread over many addresses could guess a 6-digit code. | Migration 250 adds `failed_attempts`. A challenge stops working after 5 wrong codes, and the user asks for a new one. |
| F3 | A06 Vulnerable components | The media app's `vue-i18n` 9.14.5 has a high advisory (XSS through `escapeParameter` and `srcdoc`) with no 9.x fix. The app doesn't use `v-html`, so it isn't reachable today. | Upgraded to 11.4.24; the stage browser run passed 13/13 with it. |
| F4 | A01 Access control | Members who may list only their own uploads could list every folder name in the library. | They see only the folders that hold their own files, and the ancestors of those. |
| F5 | A02 Misconfiguration | API responses carried no security headers. | Every edge response now gets `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS, a deny-all CSP, CORP `same-site` and `Cache-Control: no-store` (unless the handler set one). |
| F6 | A02 Misconfiguration | Prod CORS accepted `localhost` and `127.0.0.1` origins with credentials. Sessions are bearer tokens, so this was defence in depth. | Local origins are allowed on dev and stage only. |

## Found and not fixed in PV-31

| # | Category | Finding | Plan |
|---|---|---|---|
| O1 | A03 Supply chain | The admin console ran **Next 15.0.3 with OpenNext 1.0.4**, which have published critical and high advisories, the middleware authorisation bypass among them. `pnpm audit --prod` listed 91 advisories (6 critical, 35 high), almost all through the console. | **Fixed in PV-32:** Next 15.5.29, OpenNext 1.20.16, React 19 stable, zod 4, and same-major overrides for transitive tooling. 0 critical, 0 high remain. The Security workflow now fails CI on any unaccepted high or critical advisory (`tooling/security/audit.mjs`; accepted ones need a reason and a review date). |
| O2 | A03 Supply chain | GitHub Actions are pinned by tag, not by commit SHA. | The Security workflow (PV-32) pins by SHA. The orun-generated `ci.yml` still uses tags; pin it when the generator supports it (G81). |
| O3 | A09 Logging and alerting | Login failures are recorded as security events, but nothing alerts on a spike, a burst of takedowns or many failed pipeline runs. Per-file actions aren't audited (G26). | Alerts from Workers Logs and the events outbox, PV11 (G82). |

## By category

### A01 Broken access control
- **Every decision is policy-worker's.** Media routes call `authorizeOnLibrary` for a named action. A denied or cross-org request gets **404, never 403**, so the existence of a resource doesn't leak. Tests: `libraries.test.ts`, `uploads.test.ts`, `browse.test.ts`.
- **Tenancy:**
  - storage keys are `org/<orgId>/lib/<libraryId>/…`;
  - each library's index is a Durable Object named by (org, library) that refuses any other scope (`assertScope`);
  - every `media_` table has `org_id NOT NULL` (`tables.test.ts`).
- **Uploader-only members** list, read, open live sockets and see folders for their own uploads only (F4).
- **Platform operators** live in a hand-filled table outside the repo; anyone else gets 404 on admin routes (`abuse.test.ts`).
- **Live sockets** open with a one-use, 60-second ticket from an authorised API call. Events carry ids, folders and states only. Sockets expire after an hour, and reconnecting re-checks membership (G75).
- **Public sharing is off in prod** until CSAM scanning and the domain exist (PV-34, risk PV-A): `PUBLIC_SHARING=off` makes media-worker refuse anything public and serve-worker require a signature for every file. Dev and stage keep it on.
- **Serving:** private files need a signed URL (an HMAC over the path and an expiry, with per-library keys held in the serving map by key id). A taken-down file or a suspended team answers 451.

### A02 Security misconfiguration
- **The app** (media-web) sends a strict CSP (`script-src 'self'`; connect only to `*.workers.dev`), `frame-ancestors 'none'`, `nosniff` and a referrer policy. The build fails if a script uses `eval` (`scripts/check-csp.mjs`).
- **Served files** get `default-src 'none'; sandbox` and `nosniff`. They display inline only for an allow-list of types (images, video, audio, PDF, plain text). HTML, SVG, XML and everything else downloads as an attachment, so an uploaded HTML or SVG file can't run script on the serving origin.
- **The API** sends the headers listed under F5.
- **Prod** returns no login codes: `DEBUG_DELIVERY=false`, verified live on 2026-11-28. Local CORS origins stay out of prod (F6).

### A03 Software supply chain failures
- There's a committed lockfile (`pnpm-lock.yaml`).
- Upstream code is ported from pinned SHAs, with derivation headers and a checked port inventory.
- A dependency gate in CI (PV-32): `pnpm audit --prod` must show no unaccepted high or critical advisory, on every PR, every push to main and weekly. Patched transitive versions are pinned with same-major overrides in `pnpm-workspace.yaml`.
- Open: O2 (action pinning in the generated `ci.yml`).

### A04 Cryptographic failures
- Session tokens and login codes are stored as SHA-256 hashes, never in plain text.
- Signed URLs use HMAC-SHA-256 with per-library keys.
- BYO storage credentials (PV7) will be envelope-encrypted and decrypted only in storage-worker.
- Live tickets are 256-bit random values, used once.
- Everything travels over HTTPS (HSTS on the API).

### A05 Injection
- **SQL** is parameterised everywhere. The only SQL assembled from strings is fixed fragments (the type filters and the `WHERE` list), never user text.
- **Search text** becomes quoted FTS5 prefix terms (`ftsQuery`), so FTS syntax can't be injected (`browse.test.ts`).
- **HTML:** the report form and the 451 page escape all text. The app renders through Vue templates (escaped) and has no `v-html`. Link snippets escape names for Markdown, HTML and BBCode (`links.test.mjs`).
- **Headers:** `Content-Disposition` names are escaped, and RFC 5987-encoded.
- **Paths:** folder and name input refuses `.`, `..` and control characters. Object keys never contain user paths (they're addressed by hash).

### A06 Insecure design
- Every collection is bounded: pages hold at most 200, batches 1,000, folder drops 2,000, and a library 500 live sockets.
- Uploads have quotas (storage, uploads a month, file size), and every upload's SHA-256 is verified at commit.
- **Safety:** free-plan public images are served only after moderation. An unclear moderation answer holds the file, so failures close, not open.
- **Rate limits:**
  - auth: 10 a minute per IP;
  - API families: 60 a minute per identity;
  - report form: 5 a minute per IP;
  - uploads have their own budget.

### A07 Identification and authentication failures
- Email codes last 10 minutes, are used once, and allow 5 wrong guesses (F1, F2).
- Sessions last 30 days, are revocable, and are stored as hashes.
- The API and sockets don't use cookies (bearer tokens and tickets). The only cookie is the OAuth state, and it's `Secure`.

### A08 Software or data integrity failures
- Upload bytes are verified against their SHA-256 at commit, and deduplicated by hash.
- Pipeline swaps (the cleaned copy with GPS removed) are checked against the file's current hash, so a stale run can't overwrite a newer upload.
- Webhooks (PV6 onwards) will be signed.

### A09 Security logging and alerting failures
- Security events are recorded for login failures; audit rows for library-level actions.
- media-worker sends Workers Logs. Logs never contain file contents, EXIF, signed URLs or upstream error text: pipeline failures store ids and step names only.
- Open: O3.

### A10 Mishandling of exceptional conditions
- Handlers return generic error messages; internal errors are logged by id, never echoed.
- **Failures close:**
  - a failed pipeline run holds the file;
  - unreadable moderation holds it;
  - a missing serving route is 404;
  - an index scope mismatch refuses.
- The outbox drains at least once and idempotently, and the sweep restarts lost runs.

## Checklist for every task

Each PR says which of these it touches and what it did:
1. **Access:** every new route calls policy for a named action; deny is 404; tenancy is checked in the index or by `org_id`; uploader-only members see only their own files.
2. **Input:** validated and bounded (length, count, type). No user text in SQL, HTML, headers or paths unescaped.
3. **Secrets and crypto:** nothing secret in code, logs, URLs that get logged, or the repo. Tokens are random, hashed at rest and short-lived.
4. **Abuse:** rate limits and quotas on anything public or expensive. Anonymous endpoints are rate-limited per IP.
5. **Failure:** fails closed; errors are generic; no stack traces or upstream text reach a response or a log.
6. **Headers and serving:** user content is never rendered as HTML on an origin with privileges.
7. **Dependencies:** no new package with a high or critical advisory (`pnpm audit --prod`).
8. **Logging:** security-relevant actions leave an audit or security event, without personal data or contents.

### Share links (PV-35): how the checklist was met
- **Access:** creating, listing and revoking need `share.create` (editors and managers). A guest's token reaches only the shared file, or the served files under the shared folder; any other file id, in this library or another, is 404 (`shares.test.ts`).
- **Secrets:** the token is 256 random bits, stored only as a SHA-256. Passwords are PBKDF2-SHA256 at 100,000 iterations (the Workers limit) with a 16-byte salt. The unlock cookie is an HMAC keyed by the stored password hash: `HttpOnly; Secure; SameSite=Lax`, scoped to the link's path, valid 12 hours, and void once the password changes or the link is revoked.
- **Abuse:** password tries are limited to 5 a minute per address and link, under the general per-IP limit. Download limits are counted by one conditional `UPDATE`, so concurrent downloads can't overshoot.
- **No caching of the grant:** every page and byte asks media-worker, which reads the link from D1. A revoked link is 404 on the next request.
- **Pages:** no referrer (the token is in the URL), `noindex`, `no-store`, a deny-all CSP with images and media from self, and no framing. Names are escaped. File bytes keep the sandbox CSP and download unless the type is in the inline list.
- **Prod:** off with public sharing (PV-34).

### Upload links (PV-36): how the checklist was met
- **Access:** only managers (`upload_link.manage`) create, list and revoke links. A guest's token can only add files to its one folder: it reads nothing, lists nothing, and never replaces an existing file (same names get a number).
- **Abuse:**
  - links expire (7 days by default, at most 90);
  - each file is checked for type and size against the link and the library, and against the team's quota;
  - the count and bytes are reserved in one conditional `UPDATE` before the bytes are read, so parallel guests can't pass the limits (tested);
  - submissions are limited to 10 a minute per address, 20 files and 95 MB each.
- **Content safety:**
  - guest files are stored private;
  - they always go through the pipeline with the safety check (GPS removal, moderation for images);
  - they wait in the review queue by default, behind a flag a replay can't clear;
  - approving one makes it private, never public.
- **Pages:** a plain form with no script, under the deny-all page CSP, with no referrer and `noindex`; names are escaped.
- **Secrets:** a 256-bit token, stored only as a SHA-256 (with an `upload:` domain separator).
- **Prod:** off with public sharing (PV-34).

### Collections and galleries (PV-37): how the checklist was met
- **Access:** changing a collection needs `file.update` (editors and managers); seeing one needs `file.list` (uploader-only members get 404). A collection share link reaches only files that are in the collection *now*: removing a file from the collection takes it out of the share at the next request.
- **Galleries** list only files that are both visibility `public` and status `public`: never private, processing, held, flagged or taken-down files. They are 404 while public sharing is off, and turning a gallery on is refused then.
- **Pages:** server-rendered with no script, a deny-all CSP (images from self), no framing; names and descriptions escaped; each file links to its own serving URL, which carries the report link.
- **Bounds:** 500 collections a library, 5,000 files a collection, 500 ids a call, 100-character names, 2,000-character descriptions.

### Comments and mentions (PV-38): how the checklist was met
- **Access:** comments follow the file. Whoever may read the file reads and writes its comments (an uploader-only member on their own files only); everyone else gets 404. Only the author edits words. The author or an editor or manager (`file.update`) resolves or deletes. A comment id from another file is 404.
- **Mentions** are checked against the library's members, and an uploader-only member is mentionable only on their own file. Others are dropped silently, so nobody can probe who exists. At most 10 per comment.
- **Email** (notifications-worker `media.comment_mention`):
  - every field is HTML-escaped, and a link that isn't plain `https://` is dropped;
  - the email carries the commenter, the file and library names, a 140-character excerpt and a link to the library in the app;
  - never the file, a file URL or a signed link;
  - one per person per comment, through an idempotency key;
  - best effort, so a failed email never fails the comment.
- **Live events** say only which file's comments changed (no words), and only to sockets that see every file.
- **Bounds:** 4,000 characters, no control characters, 1,000 comments a file. A purged file takes its comments with it.

### Activity (PV-41): how the checklist was met
- **Access:** the library's activity needs `file.list` (uploader-only members get 404); one file's activity follows that file's read access.
- **Content:** entries record the actor's id, the operation, the file and a small detail (name, destination folder, state, version). They never record file contents, comment words, IP addresses or link tokens. An operator's takedown or reinstatement shows as "operator", so a team never learns who acted.
- **Integrity and failure:** an entry is written right after the change it describes, in the same object. If writing it fails, the change still stands (the log never fails a write).
- **Bounds:** the newest 10,000 entries per library are kept; pages hold at most 200.

### storage-worker (PV-44): how the checklist was met
- **A01 access:** no public route (`workers_dev` off); callers reach it only over service bindings after authorising the user. Every object call names org, library and backend; the row is looked up by all three, and a key outside the backend's prefix (or with `.` or `..` segments) is 404.
- **A02/A04 crypto:** credentials are sealed with AES-256-GCM under a fresh per-backend data key, which is sealed under `STORAGE_KEK`; both seals carry the org, library and backend id as additional data. The key is generated in CI with `openssl rand`, piped to Cloudflare, never printed. Sealed values are never returned; responses list the endpoint, bucket, prefix and status only.
- **A10 SSRF:** https host names only; IP literals (v4 and v6), localhost, `.local`, `.internal`, metadata names, user info, ports other than 443 and paths are refused. Redirects aren't followed. Every request has a deadline. Not done: a DNS-time check (GAPS G94).
- **A08 integrity:** uploads with a checksum are hashed in the worker before sending, as well as signed, since not every S3-compatible server checks the signed hash.
- **A09 logging:** errors carry S3 codes (`AccessDenied`, `NoSuchBucket`, `Timeout`), never URLs, keys or secrets. A backend's last error is a code.

### Per-library stores (PV-45): how the checklist was met
- **A01 tenancy:** the store is chosen from the library's own backend row (org and library in the query). In a customer bucket, keys are the backend's prefix plus the managed `org/<org>/lib/<lib>/` key, and storage-worker refuses anything outside the prefix. Serve-worker passes the org, library and backend from the library map, never from the request.
- **A04/A08 integrity:** uploads still carry their SHA-256 to the store; a single upload to a customer bucket is re-hashed from what the bucket holds before it becomes a file, as multipart uploads already were.
- **A09/A10:** a refusing or missing bucket is a 502/503 with no detail to the visitor; the code stays in storage-worker's answer to media-worker. A missing bucket is no longer read as a missing file.

### Ahead: what the next milestones must design in
- **PV6, sharing (remaining):**
  - share and upload-link tokens are 256-bit random and stored hashed;
  - passwords are hashed with PBKDF2 (WebCrypto) and a per-link salt;
  - expiries and download caps;
  - rate limits on password tries;
  - upload links enforce type, size and count;
  - no listing of a share's siblings.
- **PV7, BYO storage (SSRF):**
  - endpoints must be HTTPS hostnames, never IP literals;
  - private, loopback, link-local and metadata ranges are refused after DNS resolution;
  - no redirects followed;
  - credentials are envelope-encrypted and never returned.
- **PV8, custom domains:**
  - verify ownership before routing;
  - guard against dangling-DNS takeover when a domain is removed;
  - user content stays sandboxed per A02.
- **WebDAV (PV9):**
  - app passwords hashed, limited per user and revocable;
  - Basic auth only over HTTPS;
  - rate-limited.
