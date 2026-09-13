# Routine: running a drive (staging-first)

The loop for testing one area end to end. Complements `docs/TESTING-PLAYBOOK.md`
(the gates and specialists) with the mechanics of a staging drive.

## 0. Before you start
- `git fetch origin dev` in both repos and branch from `origin/dev` — others
  push mid-session (a squash-merged branch guarantees a phantom conflict).
- Confirm the app is on staging: `blendn/ashgabat/.env.development.local` has
  `EXPO_PUBLIC_API_BASE_URL=https://staging-api.blendn.app`. If you changed it,
  restart Metro with `--clear` (EXPO_PUBLIC_* is baked at bundle time).

## 1. Pick the area, state the artefacts
If the drive will edit a dashboard screen, the design chain is **gated** —
state the three artefacts before the first edit (`docs/DESIGN-CHAIN.md`).

## 2. Seed the data you need — on staging
Create it through the **product**, not raw SQL, wherever possible: sign in as a
seed account and drive the setup (RSVP, check-in, send, report…). Only reach for
the staging DB to read a row back or to place a fixture the UI cannot
(e.g. a check-in the emulator's dead GPS can't make). Reads are always fine;
writes should be through the API. See `reference/environment.md` for the staging
DB access pattern.

## 3. Drive it on the surface a real person uses
- **Dashboard** journeys: gstack `browse` (or Chrome DevTools) against
  `staging-dashboard.blendn.app`, signed in with a seed account.
- **Mobile** journeys: the iOS simulator **and** the Android emulator, both on
  the staging bundle. See `routines/driving-the-app.md`.
- A dashboard-only or API-only path is a partial drive — say so and keep the
  ticket open (`8 · Driven / Read back` in the playbook).

## 4. Read the row back
Every write gets a `SELECT` (or a GET) proving what landed. An API 200 proves
nothing was written. Quote the row in the ticket and the PR.

## 5. If you found a bug
- Fix it on a branch off `origin/dev`. Root cause, not symptom — grep every
  caller of the function you touch.
- **Negative control**: for every structural/grep guard, apply the mutation,
  watch it fail, revert, and register it in `__tests__/negative-controls.json`.
- Lint before the PR (CI fails on unused imports tsc/jest pass).
- One Jira ticket per finding, In Review on the PR (see `reference/conventions.md`).

## 6. Land and verify on staging
`routines/landing-and-staging.md`. A fix is **Done** only after it is verified
on staging (the row read back on staging, or the flow re-driven there).

## The recurring failure this catches
Every defect this project shipped passed unit + integration + a screenshot: the
interest graph nobody wrote, the preference that stored `true` for "no", the
push token that survived sign-out, the safety message that never reached the
queue. Each was caught by driving the product and reading the database.
