# Reference: conventions

## Jira
- Project `SCRUM`. Transitions: `11` To Do, `21` In Progress, `31` In Review,
  `41` Done.
- **In Review** = fixed on a branch with a PR. **Done** = landed on `dev` and
  verified on staging (row read back / flow re-driven there).
- One ticket per finding. The description carries: how it was driven, the row
  read back, the fix, and the PR. Recorded-not-fixed product gaps get a ticket
  too, marked as a decision for the owner.
- The Atlassian MCP has **no delete-issue** tool — close as Done or Superseded,
  never delete.

## Branches and promotion
- Branch from `origin/dev`; squash-merge into `dev`; fast-forward `dev`→`staging`.
  Details in `routines/landing-and-staging.md`.
- Railway auto-applies migrations on deploy — never hand-apply.

## Negative controls (mandatory for structural guards)
Every grep/structural test ships with a documented mutation that was applied,
observed to fail, and reverted — registered in `__tests__/negative-controls.json`
(`verified` map). A guard that passes against broken code is worse than none.
Rules learned the hard way:
- A structural guard may not use a negated character class (`[^}]*`) to cross a
  delimiter — brace-match instead.
- Pin the **producer** of a value, not only its consumer.
- A `data:`-block shorthand can hide an `undefined`; the shorthand ratchet
  (`__tests__/prisma-shorthand-ratchet.test.ts`) guards it.

## The design chain (gated)
Do not edit a file for a dashboard screen until the chain's three artefacts
exist and are stated in the response: operator questions + cuts, a direction
with a per-screen memorable detail, a mockup on disk. See `docs/DESIGN-CHAIN.md`
and the per-screen status in `docs/DASHBOARD-REDESIGN-CHECKLIST.md`.

## Prisma gotchas that cost a debug cycle each
- `{ field: { not: X } }` on a **nullable** column excludes NULL rows — write
  the explicit OR.
- A `P2002` here has **no `meta.target`** (driver adapter nests it) — match on
  the constraint via `lib/prisma-errors.ts`, not `meta.target`.
- Socket emits need `globalThis` — Next bundles its own copy of the socket
  server; prove delivery with a socket probe, not a 200.

## Specialist passes
Run the coverage + specialist fan-out from `docs/TESTING-PLAYBOOK.md` every time
(coverage always; schema/latency/API/security/comment-rot/a11y by trigger).
