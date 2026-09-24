# Agent playbook — how to conduct testing on this project

Start here. This directory is the operating manual for an agent driving the
Blendn end-to-end testing programme. It is **operational** (how to run a drive,
where the environment is, what the conventions are); the **gated method** lives
in the canonical docs it links to.

## The two repos
- **Backend / dashboard** — `blendn-admin` (this repo, `seville` worktree).
  Next.js 15 App Router: the dashboard (`app/dashboard/*`) and the mobile REST
  API (`app/api/mobile/*`).
- **Expo client** — `blendn` (`ashgabat` worktree). The React Native app.

## Operating mode: staging-first (2026-09-13 →)
The app is pointed at **staging**, not local. Seed data is created **on
staging**, drives run **against staging**, backend changes are pushed and
**promoted to staging**. Local Docker Postgres is kept only for integration
tests that need a database in-process. See `reference/environment.md`.

**Never target production.** Staging only: `staging-api.blendn.app` /
`staging-dashboard.blendn.app`.

## The gate, in one line
A flow is not tested until it has been **driven end to end on the surface a
real person uses** and the **row it wrote has been read back**. Green unit +
integration + a screenshot is not that. One Jira ticket per finding.

## Read in this order
0. **`TEST-PLAN.md` — the programme: the Jira queue (`tq`), how to claim a unit,
   attendee lanes, the world log. Start every testing session here.**
1. `routines/testing.md` — how a drive actually runs, staging-first.
2. `routines/driving-the-app.md` — iOS sim, Android emulator, Maestro, the GPS fact.
3. `routines/landing-and-staging.md` — PR → dev → staging promotion.
4. `reference/environment.md` — URLs, seed accounts, Docker, ports, tokens.
5. `reference/conventions.md` — Jira, branches, negative controls, the design chain.

## The canonical method docs (do not duplicate — link)
- `docs/TESTING-PLAYBOOK.md` — the six gates, specialist fan-out, the local loop.
- `docs/DESIGN-CHAIN.md` — the gated chain before editing any dashboard screen.
- `docs/DASHBOARD-REDESIGN-CHECKLIST.md` — per-screen status + the drive log.
- `docs/LIVE-EVENT-INSIGHTS.md` — the metrics/real-time-feedback inventory.
