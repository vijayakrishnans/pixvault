# serve-worker

Pixvault's public file server. `GET /<orgSlug>/<libSlug>/<path>` serves a library's files: public files to anyone,
private files only with a signed link (`?exp=…&sig=…`) from media-worker. It applies the library's preset
transforms (`?preset=thumb|small|medium|large`), referrer and IP rules, a per-IP rate limit and the random-image
API (`/_random?folder=…`), and writes one Analytics Engine data point per serve.

## Depends on

- media-worker (its `LibraryIndex` Durable Object, for the random-image API)
- cloudflare-kv-media (library maps and file routes)
- cloudflare-r2 (the managed bucket, read-only)

## Depended on by

- (none: browsers and embeds call it directly)
