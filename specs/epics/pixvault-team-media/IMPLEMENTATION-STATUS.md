# pixvault-team-media (PV): implementation status

As-built ≠ intent. This file records what actually shipped and every place the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| PV0: the spec | ✅ done 2026-11-27: PV-1 doc set + port inventory; PV-2 public, listing-ready repo; PV-3 WAITING.md | #3 (`0ca8a26`), #4 (`213d751`), PV-3 (this PR) |
| PV1: libraries and access | in progress: PV-4 backend (libraries, roles, guests, media-worker, facade, matrix and isolation tests) | PV-4 (this PR) |
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

### PV1

- **Org role names.** The brief's org "member" is Cirrus's `builder`. `billing_admin` has no library access.
- **`everyone_in_org`** grants org builders `editor` and org viewers `viewer`. The brief didn't say which role.
- **Guests join by email invitation**, accepted on sign-in when the verified email matches
  (`POST /v1/media/invitations/accept`). There's no identity lookup by email to add a guest directly. PV1 sends no
  invitation email: the manager shares the app link, and email delivery arrives with PV6's notifications.
- **Default library.** It isn't created inside Cirrus's org-creation transaction (that would change
  membership-worker). The app creates "Library" on an owner's first visit to an org with none (PV-5).
- **Archiving a library** archives its Cirrus project best-effort. A library manager who isn't an org owner or
  admin lacks `project.delete`, so the project stays active until an admin archives it. The library is hidden
  either way.
- **Listing** asks policy-worker once per library (parallel). That's fine at tens of libraries per org; a batch
  endpoint is a later optimisation.
