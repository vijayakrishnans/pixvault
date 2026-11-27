# serve-worker — architecture

A Cloudflare Worker on workers.dev (`pixvault-serve-worker-<env>`).

## One request

1. Parse and decode the path; refuse traversal, encoded slashes and control characters.
2. Per-IP rate limit (`SERVE_RL`).
3. Library map `lib:<orgSlug>/<libSlug>` from KV (memoised in the isolate for 30 s): ids, signing keys,
   referrer and IP rules, presets, random toggle. IP and referrer rules apply here.
4. File route `route:<libraryId>:<sha256(path)>` from KV, written by media-worker's index outbox. The library id
   comes from this library's own map, so a file of another library is never reachable through this path.
5. Only `public` and `private` files serve; private files need a valid, unexpired signature over
   `(version, libraryId, path, exp)`.
6. `If-None-Match` → 304; public files from the edge cache (keyed by the bytes' SHA-256, preset and format);
   otherwise R2 (single byte ranges for originals), through the Images binding for presets.

## Headers

`nosniff`, a sandboxing CSP on every response, and `Content-Disposition: attachment` for anything that isn't a
plainly safe image, video, audio, PDF or text type (so HTML and SVG never render on this origin). Private files are
`private, no-store`.

## Boundaries

No D1 access and no user identity: it reads KV and R2 and calls media-worker's index for one read-only op
(`randomPublic`). Analytics never record an IP address or a full referrer.
