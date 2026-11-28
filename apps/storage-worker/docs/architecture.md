# Architecture

- **Credentials:** sealed per backend with a random data key (AES-256-GCM); the data key is sealed with
  `STORAGE_KEK` (a Worker secret). Both seals are bound to the backend's org, library and id, so a sealed value moved
  to another row won't open. Rows are cached sealed for a minute per isolate; they are opened per request.
- **Endpoints:** https host names only; IP literals, local and internal names, user info and odd ports are refused
  (SSRF). Requests don't follow redirects.
- **Tenancy:** every object call names the org, library and backend; a key must sit under the backend's prefix.
- **S3:** `@saas/shared/s3`, a WebCrypto SigV4 client.
