# cloudflare-kv

Provisions Cloudflare KV namespaces backing the api-edge idempotency replay store (stage and prod)

Terraform-managed infrastructure for pixvault, per environment (`stage`, `prod`; `dev` is verify-only and provisions nothing).

## Depends on

- (none)

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime (idempotency namespace)
- **media-worker**, **serve-worker** (PV3) — the `media-routes` namespace: library maps and file routes
