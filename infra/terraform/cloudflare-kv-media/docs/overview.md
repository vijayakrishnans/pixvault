# cloudflare-kv-media

Provisions the Pixvault media routes KV namespace (library maps and file routes) for stage and prod.

Terraform-managed infrastructure for pixvault, per environment (`stage`, `prod`; `dev` is verify-only and provisions nothing).

## Depends on

- (none)

## Depended on by

- **media-worker** and **serve-worker** (PV3): bind the namespace as `ROUTES_KV`
