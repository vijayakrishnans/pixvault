# cloudflare-kv-media

Pixvault's serving KV namespace, one per environment: `pixvault-media-routes-<env>`.

- **Library maps** `lib:<orgSlug>/<libSlug>` → library id, signing key version, access rules and presets.
- **File routes** `route:<libraryId>:<sha256(path)>` → object key, MIME type, size, etag and visibility.

media-worker writes them (library changes directly; file changes through the LibraryIndex outbox). serve-worker
reads one route per request. Published as `WIRING_CLOUDFLARE_KV_MEDIA` (`media_routes_kv_id`).

It's a root of its own rather than a second resource in `cloudflare-kv`: the brokered `workers-deploy` token can
create KV namespaces but not read them, so a change to an existing KV root fails on refresh (GAPS G44).
