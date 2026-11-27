# pixvault-team-media (PV): implementation status

As-built ≠ intent. This file records what actually shipped and every place the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| PV0: the spec | ✅ done 2026-11-27: PV-1 doc set + port inventory; PV-2 public, listing-ready repo; PV-3 WAITING.md | #3 (`0ca8a26`), #4 (`213d751`), PV-3 (this PR) |
| PV1: libraries and access | ✅ done 2026-11-27: PV-4 backend (libraries, roles, guests, media-worker, facade; 1,200-case matrix; isolation sweep); PV-5 multi-tenant profile; PV-6 media-web app shell and brand check. Verified live on stage | #6 (`dc41aa6`), #7 (`df92dc9`), #8 (`e34ecfc`), PV-7 smoke fix (this PR) |
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

- **The baseline shipped in the Solo (single-user) profile.** It allowed one personal org per account and 404'd
  org members, invitations and API keys at the edge. A teams product needs all of them, so PV-5 turns Solo off in
  api-edge, identity-worker, membership-worker and the console. A side effect: new accounts no longer get a
  personal org automatically, and they create their team org through the console's onboarding. The PV1 stage
  smoke caught this on its first run (`403 solo_profile` on a second org).

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
- **The app is built with Vite**, not ImgHub's Vue CLI, and uses Element Plus icons only (Font Awesome dropped).
  Ported files keep their upstream names and derivation headers. `tests/media-web` checks both against the port
  inventory.
- **A separate session from the console.** The console keeps its bearer token in its own origin's storage (and
  ships as a prebuilt artifact), so the app signs in with the same Cirrus identity (email code) and holds its own
  token. Same account, same orgs, two sign-ins. A shared-session handoff is a later improvement.
- **Team onboarding** retries with a suffixed slug when the name's slug is taken; org slugs are unique across the
  service. The headless browser run found this.
- **At 390 px**, the members and invitations tables scroll sideways inside their cards. Every control is reachable.
- **First deploy of media-web (#8)** uploaded fine, but its smoke ran 0.2 s later, while the new workers.dev host
  still answered 404, on stage and then on prod. Both hosts served the app moments later. PV-7 makes the smoke
  retry for up to 30 s, and its merge's convergence is the green record.
- **Accessibility in CI (axe) is not in PV1.** Forms use labels, buttons are buttons, focus is visible, and
  keyboard flow works in the browser run. axe joins the CI lanes with the browse UI (PV5) and is required by PV11.
