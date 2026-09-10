# The review rota

Which review runs when, and why. Written down because the expensive failures on
this project have all been the same shape — **a check that was available and was
not run** — and because "I'll remember to look" has already produced eighteen
comments describing behaviour the code does not have.

Nothing here is optional-when-busy. The rota is cheap: most of these run in the
background while the work continues.

## Always, on every change

| Gate | Command | Why it is not optional |
|---|---|---|
| Types | `npx tsc --noEmit` | |
| Lint | `npx eslint .` — **zero errors**, warnings are grandfathered | CI fails on an unused import that tsc and jest both pass |
| Unit | `npx jest` | |
| Integration | `jest --config jest.integration.config.ts` against real Postgres | 22 suites CI-only; a local loop that skips them is blind to a third of the assertions |
| Real build | `npm run build` | Caught `pg` entering a browser bundle when tsc and 2439 unit tests could not. Also the only thing that sees `export const` in a `"use server"` file |
| Server build | `npm run build:server` | `@/` aliases resolve for tsc and die at runtime |
| Negative control | apply the mutation, watch it fail, revert, record | R16. Six run on #348; two of them proved a *behavioural* suite was vacuous |

**Coverage runs every time, not at the end.** `ecc:pr-test-analyzer` against the
diff. On its first run it found a comment citing a test file that did not exist,
a year-boundary bug invisible on every screenshot, and two integration
assertions that were real assertions against tables the fixture never wrote to.

## By what the change touches

| If the change touches… | Run | Skill / agent |
|---|---|---|
| **A screen** | operator questions → tone → HTML → drive it | `ecc dashboard-builder` → `ecc frontend-design-direction` → `/design-html`, then `browse` at 375 / 768 / 1440 |
| **Any UI at all** | contrast, targets, focus order, greyscale | `ecc:a11y-architect`, `frontend-a11y`. `--faint-foreground` failed AA on nearly every screen for months |
| **A Prisma query or the schema** | index coverage against real predicates, `EXPLAIN` on live data | `ecc:database-reviewer`, `postgres-patterns`, `prisma-patterns` |
| **A hot path** — the ops tick, the feed, check-in, a `force-dynamic` page | p50/p95, round-trip count, freshness, cache hit rate | `latency-critical-systems`, `ecc:performance-optimizer`, `react-performance` |
| **An endpoint or a response shape** | envelope, status codes, pagination, versioning | `api-design`. The mobile API is 100% consistent on `lib/api-response`; dashboard routes still return raw strings |
| **Auth, PII, moderation, identity** | | `ecc:security-reviewer`, `security-review` |
| **A comment claiming a guarantee** | comment rot | `ecc:comment-analyzer`. Eighteen recorded instances and counting |
| **An error path or a fallback** | swallowed errors, fail-open recorded as success | `ecc:silent-failure-hunter`. G3 wrote `moderation_status: "clean"` for messages nobody checked |
| **A user journey** | | `e2e-testing`, `ecc:e2e-runner`, `browser-qa` |
| **Before a PR** | | `verification-loop`, then `/review` |

## How to brief a specialist agent

Four things, every time. They are why the first two passes returned findings
rather than advice:

1. **Give it the live database.** `docker exec blendn-pg17 psql -U postgres -d
   blendn_test`. Tell it to run `EXPLAIN (ANALYZE, BUFFERS)` rather than read
   the schema and reason.
2. **Tell it to separate verified from inferred**, and live from latent. Both
   passes did this well when asked and would not have otherwise.
3. **Tell it not to edit files.** Take the findings and act on them yourself, so
   the fix carries the reasoning.
4. **Say what the project's standard is** — point at
   `__tests__/negative-controls.json`, which records that a *behavioural* test
   can pass vacuously when the fixture makes it unfalsifiable.

Then fix what your own change caused and **record the pre-existing latent
findings rather than widening the diff**.

## What the rota has already caught

Kept as evidence that it pays, and as the argument against skipping it:

- A comment I wrote that afternoon citing `__tests__/event-visibility.test.ts` —
  a file that did not exist.
- `whenLabel` rendering a 31 Dec → 2 Jan run as "31 Dec → 2 Jan". The seed has
  no event crossing a new year, so no screenshot could have shown it.
- Two integration assertions running as `0 >= 0` against tables the fixture
  never wrote to.
- Two missing indexes on queries added the same week, one of them the exact gap
  `event_check_ins` already carries a bare date index to close.
- `--faint-foreground` at 3.99:1 and 3.67:1, under AA, on the nav labels and
  every table header.
- Three register entries that were stale: `User.createdAt`, `User.role` and
  `venues (latitude, longitude)` are all indexed.
