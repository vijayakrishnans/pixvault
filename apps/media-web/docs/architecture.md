# media-web — architecture

A `cloudflare-workers-assets-turbo` component: Vite builds `dist/`, and a small Worker (`worker/index.js`) serves
it with security headers (CSP, `frame-ancestors 'none'`, nosniff, a strict referrer policy) and an SPA fallback.

- **No credentials, no data.** The Worker reads nothing and binds nothing but its assets. The browser holds the
  user's bearer token (`localStorage`, `pixvault.media.token`) and sends it to api-edge.
- **Environment from the host.** `pixvault-media-web-<env>.<sub>` calls `pixvault-api-edge-<env>.<sub>`
  (`src/api/client.js`). api-edge's CORS allows exactly the same environment's media origin.
- **Upstream provenance.** Files ported from Sanyue-ImgHub keep their upstream names and start with
  `Derived from MarSeventh/Sanyue-ImgHub@1621525:<path> (MIT), modified.`. `tests/media-web` checks that every
  ported file listed in the port inventory carries it, and that no upstream brand marks ship.
- **Caching.** `/assets/*` (hashed) is immutable; the HTML shell is `no-cache`.
