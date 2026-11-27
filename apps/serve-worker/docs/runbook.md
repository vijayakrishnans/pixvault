# serve-worker — runbook

## How it deploys

Merges to `main` converge automatically: CI plans changed components (`orun plan --changed`) and runs this
component's lane. It deploys after media-worker (its Durable Object binding names media-worker's class) and after
the KV and R2 roots. Failed lanes resume with `gh run rerun --failed`.

## Rollback

Revert the offending commit on `main`; the next convergence applies the previous desired state.

## Verify

The smoke checks `/health`. For a real file, upload a public file in the app and open its link.

## Common failures

- **Every file 404s in one library**: its map is missing from the routes KV. A member opening the library in the
  app republishes it (media-worker `ensureServing`).
- **A new upload 404s for a few seconds**: the index outbox drains on an alarm, and KV reads are cached up to 60 s
  at the edge.
- **Presets answer 503**: the Images binding failed; the original still serves without `?preset`.
- **403 on embeds**: the library's referrer or IP rules exclude the caller.
