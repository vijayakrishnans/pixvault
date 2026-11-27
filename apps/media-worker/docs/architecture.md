# media-worker — architecture

A `cloudflare-worker-turbo` component: TypeScript built by the turbo pipeline from `apps/media-worker`, deployed
per environment by its CI lane.

## Bindings and wiring

- **Service bindings** → `membership-worker`, `policy-worker`, `projects-worker`: in-process RPC to sibling
  Workers; no public hops between contexts.
- **D1** `PLATFORM_DB`: the shared platform database. This Worker owns the `media_*` tables.
- **Wired configuration** (resolved at deploy time; names only): `WIRING_CLOUDFLARE_D1_STAGE`,
  `WIRING_CLOUDFLARE_D1_PROD`.

## Tenancy

- Every `media_*` row carries `org_id`, and every repository method takes the org first.
- A library is addressed as `(org_id, library_id)`. An id from another org resolves nothing.
- Decisions are policy-worker's: this Worker gathers the facts (org roles from membership-worker, library roles
  from `media_library_members`, the library's `everyone_in_org`) and asks. It never decides alone.
- A denied, missing or other-org read answers **404**, never 403.
- Managed storage keys begin `org/<orgId>/lib/<libraryId>/` (the `media_storage_backends.prefix` written at
  library creation).

## Boundaries

This Worker owns the media bounded context: its tables, its invariants and its API surface (exposed through the
edge). Cross-context calls go over service bindings; nothing else may reach into its storage.
