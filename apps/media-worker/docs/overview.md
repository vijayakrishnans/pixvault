# media-worker

Cloudflare Worker for Pixvault media: libraries (shared drives on Cirrus projects), library roles, guests and
their invitations. Later milestones add files, folders, uploads and sharing (see
`specs/epics/pixvault-team-media/`).

Part of the pixvault runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only).
Not publicly routable. It is reached only through `api-edge` (`/v1/organizations/{org}/libraries/…`,
`/v1/media/…`), which resolves the caller and forwards `x-actor-*` headers.

## Depends on

- **membership-worker**: the caller's org role facts
- **projects-worker**: a library is created as a Cirrus project, as the caller
- **policy-worker**: every decision (org role ∪ library role, evaluated by `packages/policy-engine`)
- **cloudflare-d1**: the media control tables (`200_media_control`)

## Depended on by

- **api-edge**: the media facade
