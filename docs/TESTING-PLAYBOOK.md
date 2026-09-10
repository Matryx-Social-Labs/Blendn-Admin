# The testing playbook

**Read this before testing anything.** Every page, every path, every fix runs the
same chain. It is not a menu — the point is that it is the same every time, so a
check is never skipped because somebody was in a hurry.

The expensive failures on this project have all been one shape: **a check that
was available and was not run.** Everything below exists because skipping it
cost something, and the last section names what.

---

## 0 · Before anything

```bash
git fetch origin && git rev-list --count HEAD..origin/dev   # must be 0
```

Others push to `dev` mid-session, in both repos. Branch from `origin/dev`, never
a local `dev`.

---

## 1 · The chain, for every page or path

Run it in this order. Steps 1–3 are the *design* chain; 4–6 are *verification*;
7 is the specialist fan-out. None is optional.

| # | Step | Skill / command | What it is for |
|---|---|---|---|
| 1 | **Operator questions** | `ecc dashboard-builder` | Derive the screen from *what does this person need answered, in what order* — never from the columns the table happens to have. Cut vanity panels here, before drawing anything. |
| 2 | **Direction** | `ecc frontend-design-direction` | Purpose, audience, tone, **one memorable detail**, constraints. A SaaS ops tool is dense, quiet, scannable. |
| 3 | **Build at fidelity** | `/design-html` | Only for a NEW composition. A strip added to an existing screen does not need a mockup; say so rather than skipping it silently. |
| 4 | **Drive it** | `browse` at 375 / 768 / 1440 | Screenshot and *look*. Half the findings on this project came from opening the page, not from reading it. |
| 5 | **Measure it** | contrast, overflow, heading order, DOM size | See §3. `--faint-foreground` failed AA on nearly every screen for months because nobody measured. |
| 6 | **Gates** | see §2 | tsc · lint · unit · integration · real build · server build. |
| 7 | **Specialists** | see §4 | Fan out in the background while you keep working. |

---

## 2 · The gates — every change, no exceptions

```bash
npx tsc --noEmit
npx eslint .                                    # ZERO errors; warnings are grandfathered
npx jest                                        # unit
DATABASE_URL="postgresql://postgres:postgres@localhost:55433/blendn_test" \
MOBILE_JWT_SECRET="local-integration-secret-at-least-32-chars-long" \
  npx jest --config jest.integration.config.ts  # real Postgres
npm run build                                   # the REAL build
npm run build:server                            # tsc for server.ts
```

Why each one is here, in the words of the thing it caught:

- **integration** — 22 suites are CI-only. A local loop that skips them is blind
  to a third of the assertions, and has been.
- **`npm run build`** — caught `pg` entering a browser bundle when tsc and 2,439
  unit tests were green. It is also the only layer that sees `export const` in a
  `"use server"` file.
- **`build:server`** — `@/` aliases resolve for tsc and die at runtime with
  `MODULE_NOT_FOUND`, on boot, in production only.

### Negative controls (R16)

Every **structural** guard — any test that reads source files — ships with a
mutation that was applied, observed to fail, and reverted, recorded in
`__tests__/negative-controls.json`.

```bash
cp path/to/file.ts /tmp/x.bak        # never `git checkout` to revert; you may have unsaved work
# break the thing the guard protects
npx jest path/to/guard.test.ts       # MUST fail, and name the right assertion
cp /tmp/x.bak path/to/file.ts
npx jest path/to/guard.test.ts       # green again
```

**A behavioural test can be vacuous too.** Two integration assertions here ran as
`0 >= 0` because the fixture never wrote to the tables they asserted on. If a
behavioural test replaces a vacuous one, register its control anyway.

Two rules earned the hard way:

- A structural guard **may not use a negated character class to cross a
  delimiter** (`[^}]*`, `[^)]*`) — it stops at the first nested one. Brace-match.
- A guard must **pin where a value comes from, not only what is done with it**,
  and must not pin a scheduling decision it has no opinion about.

---

## 3 · Measuring a screen

```bash
B=~/.claude/skills/gstack/browse/dist/browse
$B viewport 1440x1300 && $B goto "http://localhost:3100/dashboard/<page>"
$B screenshot artifacts/design/<page>.png        # then Read it — actually look
$B console --errors
$B js "JSON.stringify({
  rows: document.querySelectorAll('tbody tr').length,
  docHeight: document.documentElement.scrollHeight,
  h1: [...document.querySelectorAll('h1')].map(e=>e.textContent),
  overflow: [...document.querySelectorAll('*')]
    .filter(e=>e.scrollWidth>e.clientWidth+2 && e.clientWidth>0).length
})"
```

Thresholds worth reacting to: **more than ~50 rows or ~4000px** means the screen
has no pagination and is rendering the table; **two `h1`** means the page is
fighting `site-header`; **any overflow** at 375 is a bug.

Contrast is measured through a canvas, not computed — oklch → sRGB is not a
lightness-to-luminance identity. The snippet lives in this repo's history; the
floor is **4.5:1** for text under 18.66px, on `--background` *and* on `--card`.

---

## 4 · The specialists — what to run when

Fan these out in the **background** and keep building. `ecc:pr-test-analyzer`
runs **every time**, not at the end.

| Trigger | Agent | Skill to read first |
|---|---|---|
| **Always** | `ecc:pr-test-analyzer` | — |
| Prisma query or schema | `ecc:database-reviewer` | `postgres-patterns`, `prisma-patterns` |
| A hot path — the ops tick, the feed, check-in, any `force-dynamic` page | `ecc:performance-optimizer` | `latency-critical-systems`, `react-performance` |
| An endpoint or a response shape | `ecc:security-reviewer` (does both jobs) | `api-design` |
| Auth, PII, moderation, identity | `ecc:security-reviewer` | `security-review` |
| Any comment claiming a guarantee | `ecc:comment-analyzer` | — |
| An error path or a fallback | `ecc:silent-failure-hunter` | `error-handling` |
| Any UI | `ecc:a11y-architect` | `frontend-a11y`, `accessibility` |
| A user journey | `ecc:e2e-runner` | `e2e-testing`, `browser-qa` |
| Before a PR | — | `verification-loop`, then `/review` |
| React/TS specifics | `ecc:react-reviewer`, `ecc:typescript-reviewer` | `react-patterns` |
| Dead code after a refactor | `ecc:refactor-cleaner` | — |

### How to brief one so it returns findings, not advice

Four things, every time. They are the difference between the two useful passes
and a page of generic guidance:

1. **Give it the live database** — `docker exec blendn-pg17 psql -U postgres -d
   blendn_test` — and the running dev server, and tell it to `EXPLAIN (ANALYZE,
   BUFFERS)` and time real requests rather than reason from the schema.
2. **Make it separate what it verified from what it inferred**, and *live* from
   *latent*. Both good passes did this only because they were asked.
3. **Tell it not to edit files.** Take the findings and act on them yourself, so
   the fix carries the reasoning.
4. **Name the project's standard** — point at `__tests__/negative-controls.json`,
   which records that a behavioural test can pass vacuously when the fixture
   makes it unfalsifiable.

Then **fix what your own change caused, and record the pre-existing latent
findings** rather than widening the diff.

---

## 5 · The local loop

```bash
docker start blendn-pg17     # or the run line in docs/MERGE-RUNBOOK.md — port 55433, Postgres 17
export DATABASE_URL="postgresql://postgres:postgres@localhost:55433/blendn_test"
export MOBILE_JWT_SECRET="local-integration-secret-at-least-32-chars-long"
export NEXTAUTH_SECRET="local-nextauth-secret-at-least-32-characters"
export NEXTAUTH_URL="http://localhost:3100" PORT=3100
npm run db:migrate
SEED_PASSWORD='Blendn-Local-2026!' npm run seed:qa -- --apply
npx tsx scripts/seed-categories.ts
npm run dev                  # 3100, so it never collides with anything on 3000
```

Sign in as `sagar.kishore@blendn.app`.

Three traps that have each cost time:

- **`seed:qa` is a dry run without `--apply`**, and prints the accounts either
  way — so the login looks seeded and is not.
- `browse` refuses `file://` outside the repo, so an HTML mockup must be copied
  into the worktree first.
- `MOBILE_JWT_SECRET` unset makes `refresh-token-store.itest.ts` fail with
  something that reads like a code defect. It is the shell, not the branch.

**Integration suites must clean up what they create.** CI gets a fresh database
every run, so a leak is invisible there and accumulates only in the one
environment where somebody is looking at the product. `matches.itest.ts` left
58 categories named "Techno" on the taxonomy screen this way.

---

## 6 · Jira

A ticket per area, closed with the commit that fixed it. The MCP has **no
delete** — close as *Done* what was fixed, and as *superseded* what was replaced,
with a pointer. Verify a ticket against the code before closing it: several
"To Do" tickets here describe work that shipped weeks ago.

---

## 7 · What this has already caught

Kept as the argument against skipping it:

| Found by | What |
|---|---|
| coverage pass | A comment citing `__tests__/event-visibility.test.ts` — written that afternoon, for a file that did not exist |
| coverage pass | `whenLabel` rendering a 31 Dec → 2 Jan run as "31 Dec → 2 Jan". No screenshot could show it; the seed has no event crossing a new year |
| coverage pass | Two integration assertions running as `0 >= 0` against tables the fixture never wrote to |
| security pass | A sponsor could list their organisation's events — `eventPermissions` denies them row by row, the list filter did not |
| schema pass | Two missing indexes on queries added the same week, one the exact gap `event_check_ins` already carries a bare date index to close |
| latency pass | Two pure waterfalls in `buildAdminOverview`; `findMany`/`count` serialised in two places |
| comment pass | Two of my own comments giving different counts for the same incident |
| measuring | `--faint-foreground` at 3.99:1 and 3.67:1 — under AA, on the nav labels and every table header |
| measuring | The venue index rendering **395 rows in a 15,812px document** with no search and no pagination |
| driving it | A filter keyed on a field whose values could never match its options — a control that selected nothing while looking like it worked |
| `npm run build` | `pg` in a browser bundle; `export const` in a `"use server"` file |

And three guards that did not catch what they existed for, because each looked
only where the last bug was: the `"use server"` guard (hardcoded three
filenames), the double-`h1` ratchet (read `page.tsx` only, missed an `h1` one
import away), and `authz-scoping-boundary` (catches a comparison, not a where
clause). **A guard that only looks where the last bug was is not a ratchet.**
