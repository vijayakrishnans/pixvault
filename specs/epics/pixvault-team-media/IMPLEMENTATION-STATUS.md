# pixvault-team-media (PV): implementation status

As-built ≠ intent. This file records what actually shipped and every place the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| PV0: the spec | ✅ done 2026-11-27: PV-1 doc set + port inventory; PV-2 public, listing-ready repo; PV-3 WAITING.md | #3 (`0ca8a26`), #4 (`213d751`), PV-3 (this PR) |
| PV1: libraries and access | | |
| PV2: index, storage, uploads | | |
| PV3: serving | | |
| PV4: pipeline and safety | | |
| PV5: browser and live collaboration | | |
| PV6: sharing | | |
| PV7: BYO storage | | |
| PV8: custom domains | | |
| PV9: developer surface | | |
| PV10: import | | |
| PV11: prod and launch | | |

## Departures from the design

### PV0

- **Account and Cloudflare connection.** The brief named account `openproduct-sms84q22` and the `nexo` connection.
  The workspace lives in `openproduct-6ny98czp` (the user's choice) on its active Cloudflare connection, because
  `nexo` is revoked there (WAITING W-8).
- **Baseline.** Built on `cirrus-baseline` v29 because `cirrus` is retired (PV-J).
- **No `orun/compliance` check** is posted on this repository; the pen is kept by hand and `orun task check` runs
  before every push.
- **Cloudflare scopes.** Queues and custom hostnames can't be minted by Orunbase today (WAITING W-3). PV4's queue
  and PV8 wait on it.
