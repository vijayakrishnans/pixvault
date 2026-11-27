# media-web

The Pixvault media app: Vue 3 + Element Plus, ported from Sanyue-ImgHub (MIT) at `1621525`, served by Workers
Static Assets at `pixvault-media-web-<env>.<subdomain>.workers.dev` (later `app.<domain>`).

It signs in with Cirrus email codes and talks only to `api-edge` (`/v1/auth/…`, `/v1/organizations/…`,
`/v1/media/…`). PV1 covers sign-in, team onboarding, the org and library switcher, the default library, library
creation, settings (general, upload rules, access rules) and members with guest invitations. Upload and browse
arrive in PV2 and PV5.

## Depends on

- **api-edge**: every request, from the browser, with the user's bearer token

## Depended on by

- (none)
