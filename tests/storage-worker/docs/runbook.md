# Runbook

Run `pnpm test` in `tests/storage-worker`. A failure in the SigV4 or envelope tests means a wire or crypto change;
fix the code, never the expected values.
