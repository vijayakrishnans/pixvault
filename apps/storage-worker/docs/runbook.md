# Runbook

- **`/health` says `kek: false`:** the key secret is missing. The deploy's smoke step creates it; a re-deploy fixes it.
  Never delete `STORAGE_KEK`: a new key can't open credentials sealed under the old one, and every customer would have
  to enter their bucket keys again.
- **A backend shows `error`:** `last_error` holds the S3 code from the last check (`AccessDenied`, `NoSuchBucket`,
  `Unreachable`, …). Ask the customer to fix the bucket or keys, then run the check again.
