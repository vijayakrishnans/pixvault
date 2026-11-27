# Pixvault ledger

Read this first on every resume. State that a tool can answer (`task_get pixvault-team-media`, `gh pr list
--state all`, `runs_list`) wins over this file; this file holds what tools can't answer: inputs, decisions and why,
measured numbers, deferred items.

## Inputs actually used

| Input | Value |
|---|---|
| Orunbase account | `openproduct-6ny98czp` (`ws_6NY98CZP`): the user's choice on 2026-11-27, replacing the brief's `openproduct-sms84q22`, where this login has no account role |
| Workspace | `Pixvault` / `pixvault` / **`ws_KG0H9PEH`** (public) |
| Cloudflare connection | `int_4da7181983a946dbbc3bb62a9aae9a6c` (the account's active one). The brief's `nexo` is revoked on this account and is not reconnected |
| GitHub connection | `int_e4aad5421dea4f2c85f65f75f05e9faf` → owner **vijayakrishnans** |
| workers.dev subdomain | `vijayakrishnan12994` (verified against a live Worker on the same connection) |
| Repo | https://github.com/vijayakrishnans/pixvault (public) |
| Baseline | `cirrus-baseline` `baseline-v29`. `cirrus` is retired in the registry and this is its successor |
| Product domain | none yet; `pixvault.app` isn't registered (WAITING W6) |
| IMGBED_REF | `MarSeventh/CloudFlare-ImgBed@611153e47cc839ecf28b344bcd233032a37cc216` (2026-11-21) |
| IMGHUB_REF | `MarSeventh/Sanyue-ImgHub@1621525ce523782852d46d43c4cf3d036dda520b` (2026-11-21) |
| Epic | EP-2 `pixvault-team-media` (`epc_MZ72W460`); the bootstrap's own epic is EP-1 `infra-baselining` |

## Live URLs

| | stage | prod |
|---|---|---|
| api-edge | https://pixvault-api-edge-stage.vijayakrishnan12994.workers.dev | https://pixvault-api-edge-prod.vijayakrishnan12994.workers.dev |
| console | https://pixvault-web-console-next-stage.vijayakrishnan12994.workers.dev | https://pixvault-web-console-next-prod.vijayakrishnan12994.workers.dev |

## Skill revisions run under (registry, 2026-11-27)

orunbase `fe17c72a`, software-factory `ac5be085` (same as the brief), pr-provenance `ea0af746`, design-authoring
`e6ed5ba1`, initiative-lifecycle `9ed675c8`, milestone-loop `8a814c28`, task-branch-pr `83c7d906`, orun-cli
`8c475ab2`, planning `6caf76f6`, mcp-tools `d070d616`. Full hashes are in the PR manifests.

## Decisions

- 2026-11-27: **Baseline `cirrus-baseline` v29**, not `cirrus` (retired). Same workers and conventions.
- 2026-11-27: **Facades at `/v1/organizations/{orgId}/libraries/…`**, Cirrus's real shape (brief rule 5).
- 2026-11-27: **`productdomain` empty** at bootstrap. The domain isn't owned, and the blueprint makes the domain an
  owner's step after the first deploy.
- 2026-11-27: **Licence holder "OpenProduct"**, matching the other OpenProduct repos.
- 2026-11-27: **No `orun/compliance` check is posted on this repo** (bootstrap PRs #1 and #2 had none either). The
  pen is still kept (branch, trailer, manifest, contract) and `orun task check` runs locally before every push.

## Measured

- Bootstrap: 08:07:23Z → 08:13:45Z on 2026-11-27 (about 6.5 min, exit 0); 42 components × 3 envs → 89 jobs.
- `/health` right after the bootstrap: stage 0.65 s, prod 0.54 s (cold, from WSL in India).

## Open risks and deferred items

See `specs/epics/pixvault-team-media/risks-and-open-questions.md` and [`WAITING.md`](../../WAITING.md) (W-1 … W-9).

## Pointers

- As built: `specs/epics/pixvault-team-media/IMPLEMENTATION-STATUS.md`
- Port inventory: `specs/epics/pixvault-team-media/port/README.md`
