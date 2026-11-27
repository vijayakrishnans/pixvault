# media-web — runbook

## How it deploys

Merges to `main` converge automatically: CI plans changed components and runs this component's lane. The
convergence run is the deployment. The smoke checks that `/` carries `<title>Pixvault</title>` and that a deep
link (`/o/x/l/y/settings`) gets the app shell (SPA fallback).

## Rollback

Revert the offending commit on `main`; the next convergence applies the previous state.

## Common failures

- **The app loads but every call fails with a CORS error**: api-edge's allowlist names
  `pixvault-media-web-<env>` (`apps/api-edge/src/app-config.ts`). A renamed Worker or a custom domain needs adding
  there.
- **Signed out on every reload**: the browser blocks `localStorage` (private mode). The session lasts for the tab.
