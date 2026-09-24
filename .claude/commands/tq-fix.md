---
description: Fix one finding from the Blendn test queue — root cause, test first, reviews, PR, staging, then drive the fix and close the loop
argument-hint: "<SCRUM-key> <session-tag>"
---

Fix one ticket found by the test programme, and prove the fix on staging the
way it was found. Arguments: $ARGUMENTS — the ticket key, then your session tag.

Rules that already live in the repo apply in full: `CLAUDE.md` (the design
chain gate, org-shaped authorisation, OpenAPI + `docs/API.md` with any mobile
endpoint change), `docs/TESTING-PLAYBOOK.md` (the gates, the specialists,
negative controls), `docs/agents/routines/landing-and-staging.md`.

## 1 · Take it

- Read the ticket and its `found-in-…` unit. Move the ticket to **In Progress**,
  comment `FIXING <tag>`. If someone else is fixing it, stop.
- `git fetch`; branch from `origin/dev`: `fix/<short-slug>`. Client fixes go in
  the `blendn` repo the same way.

## 2 · Understand before editing

- Reproduce it (the ticket's steps, or a failing test). gstack **investigate**
  when the cause isn't obvious.
- Find the root cause and every caller of what you'll change — fix it once,
  where all callers go through, not only on the path the ticket names.
- A dashboard screen changes? The design chain comes first (**ecc:dashboard-builder**
  → **ecc:frontend-design-direction** → **design-html**), and its three artefacts
  are stated before the first edit (`CLAUDE.md`).

## 3 · Test first, then fix

- Write the test that fails for the reason the ticket describes (integration test
  against the real route when it's an API/DB behaviour), watch it fail, fix, watch
  it pass.
- Mutation-check it (undo the fix → the test fails) and add the entry to
  `__tests__/negative-controls.json` with what failed.
- `npx tsc --noEmit -p .`, `npm run lint` (0 errors), `npx jest`, and the
  integration file you touched (local `blendn-pg17`).

## 4 · Review

- Always: **ecc:pr-test-analyzer** on the diff.
- By trigger: **ecc:security-reviewer** (auth, authorisation, sockets, uploads,
  user data), **ecc:database-reviewer** (schema, migrations, heavy queries),
  **ecc:react-reviewer** (UI). Brief them for findings, not advice; fix what
  they confirm, or say why not.

## 5 · Land

- PR to `dev` with: what was found (with the ticket's evidence), the root cause,
  the fix, the tests and mutation results. Ticket → **In Review**.
- CI green → `gh pr merge <n> --squash --subject "<PR title> (#<n>)"` (without
  `--subject` a multi-commit PR squashes under its first commit's message).
- Promote: `git fetch && git push origin origin/dev:staging` (fast-forward
  only; if it's rejected, someone promoted first — fetch and check, never force).
- Wait for the Railway staging deploy to succeed.

## 6 · Prove it where it was found

- Drive the ticket's steps on staging on the same surfaces; read the row back.
- Post the §8 line on the ticket → **Done**. Comment on the `found-in-…` unit
  that the finding is fixed; if the unit was In Review only for this, drive the
  rest of it (or put it back to **To Do** for `/tq-next`).

End with: the ticket, the PR, what was driven on staging and the read-back, and
the next command for the developer.
