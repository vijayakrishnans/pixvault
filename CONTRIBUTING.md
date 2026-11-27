# Contributing to Pixvault

Thanks for helping. Pixvault is an [Orun](https://github.com/sourceplane/orun) desired-state repository: every
change lands through a pull request that carries its task.

## Before you start

- Read [`specs/epics/pixvault-team-media/`](specs/epics/pixvault-team-media/README.md), the design of record, and
  its [port inventory](specs/epics/pixvault-team-media/port/README.md).
- Every change belongs to a task with a contract in `tasks/<KEY>.TaskContract.yaml`; its `affects` list is the
  ceiling on what the diff may touch.

## The pen

- Branch: `orun/<KEY>-<slug>` (for example `orun/PV-7-byo-wizard`).
- Every commit carries the trailer `Orun-Task: <KEY>` (`git commit --trailer "Orun-Task: PV-7" -m "…"`).
- One task per pull request. The PR body ends with the `<!-- orun:manifest … -->` block.
- Merge only when every check is green.

## Porting from upstream

Behaviour is ported from `MarSeventh/CloudFlare-ImgBed@611153e` and the UI from `MarSeventh/Sanyue-ImgHub@1621525`.
Every derived file starts with:

```ts
// Derived from MarSeventh/<repo>@<ref>:<path> (MIT), modified.
```

Update the matching rows in `specs/epics/pixvault-team-media/port/` in the same PR (re-run
`tools/port-inventory/inventory.ts`).

## Rules that keep strangers' files safe

- Every row, key, message and object is scoped to one org (and usually one library). Add a cross-org test for
  every new table, route, storage prefix and Durable Object method.
- Never commit real images or files: generate fixtures. Never log file contents, EXIF, or private or signed URLs.
- Never commit secrets. `.env*`, `.dev.vars` and values files are ignored; push protection is on.
- No ImgBed or Sanyue names, logos or backgrounds in the product; CI checks for them.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence in [LICENSE](LICENSE).
