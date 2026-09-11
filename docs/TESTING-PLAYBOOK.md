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

**This is a procedure, not a description.** Each step produces a named
**artefact**. No artefact means the step did not happen — that is the whole
mechanism, because "I considered the direction" is not checkable and "here is
the direction I wrote" is.

### Two gates

**Gate A — before writing code.**

> **You may not edit an implementation file until steps 1, 2 and 3 have each
> produced their artefact for the screen you are about to change.**

Implementation file = anything under `app/`, `components/` or `lib/` that the
screen renders through. Tests, docs and fixtures are not implementation files.

Before the first `Edit`, state the three artefacts. In full, in the response, so
they can be read. Not "ran the chain" — the artefacts themselves.

**Gate B — before calling it done.**

> **A flow is not tested until it has been driven end to end on the surface a
> real person uses, and the row it should have written has been read back.**

Green unit tests, green integration tests and a screenshot are not that. Every
defect this project has shipped passed all three: the interest graph nobody
wrote, the preference that recorded `true` when somebody said no, the push token
that survived sign-out. Each was found by driving the product and reading the
database, and each would have been missed by any amount of test-suite green.

So step 8 is not the victory lap. **It is the step that decides whether the work
counts**, and a ticket does not close until it produces its artefact — see §8.

### The steps

| # | Step | How | **Artefact — what must exist before the next step** |
|---|---|---|---|
| 1 | Operator questions | invoke `ecc dashboard-builder` | The **numbered list of questions in priority order**, plus the **cut list**: which existing panels are going and why. |
| 2 | Direction | invoke `ecc frontend-design-direction` | Five named things: **purpose · audience · tone · the one memorable detail · constraints**. Written out, not referenced. |
| 3 | Build it | invoke `/design-html` | A **file on disk** under `~/.gstack/projects/$SLUG/designs/<screen>-<date>/`, and a **screenshot of it read back**. |
| 4 | Drive the real screen | `browse` at 375 / 768 / 1440 | Screenshots, read. |
| 5 | Measure it | §3's snippet | Numbers: contrast, overflow, `h1` count, DOM size. |
| 6 | Gates | §2 | All six green. |
| 7 | Specialists | §4 | Launched in the background, in parallel with the work. Findings triaged: fix what this change caused, file the rest. |
| 8 | **Drive the journey** | §8 | Maestro flow + run for the client, a driven journey for the dashboard, **and the database row read back**. |

### Step 2 when the direction is already set

**This is where it goes wrong, so it is written out rather than left to
judgement.** The dashboard's direction *is* settled — dense, quiet, scannable,
hierarchy from type, no card-in-card, one `HeroMetric`, one gradient element.

That is not permission to skip step 2. **Restate the five, for this screen, in
one line each, and name the one memorable detail — which is per-screen and
cannot be inherited.** On the overview it was the unreached funnel stages drawn
full width in outline. On the applications queue it was the evidence ranking. If
you cannot name a memorable detail for the screen you are on, you have not done
step 2, and the screen will come out generic.

Invoke the skill anyway. It costs one call and it is what stops "the direction is
locked" becoming "I skipped the direction".

### Step 3 — the rule, with no judgement in it

The earlier version of this file said `/design-html` was "only for a NEW
composition" and told you to "say so rather than skipping it silently". **That
escape clause was used to skip it every single time**, because any change can be
argued not-new-enough. It is replaced with a test that has no opinion in it:

**Run `/design-html` if the change does ANY of:**

- adds, removes or reorders an element on the screen
- changes a layout, a grid, or the order of anything
- changes what an element *means* — a badge's tone, a number's label, an
  action's prominence
- changes more than one file the screen renders through

**Skip it ONLY for:** a copy edit with no layout change, a token value, or a
pure bug fix that alters nothing a person sees.

If you are deciding which side of the line you are on, you are on the run-it
side. The mockup is cheap; going back is not.

### Say it out loud before implementing

Before the first edit, in the response:

```
Screen: /dashboard/<x>
1 · Questions:  1. …  2. …  3. …    Cutting: … because …
2 · Direction:  purpose … · audience … · tone … · memorable detail … · constraints …
3 · Mockup:     <path>  (or: skipped — copy-only change, no layout effect)
```

Three lines. If any is missing, go back and get it rather than proceeding —
noticing at step 6 that step 2 never happened is noticing after the code is
written, which is the same as not noticing.

**And before saying it is done:**

```
8 · Driven:     <maestro flow + result, iOS>  |  <same flow, Android>  |  <dashboard journey driven>
    Read back:  <the SELECT, and what it returned>
    Or:         not driven — <the specific reason>, and the ticket stays open
```

"Not driven" is an allowed answer. Silently not driving is not.

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
| An endpoint or a response shape | `ecc:security-reviewer` (does both jobs) | `api-design`, and `contract-first` when it has a consumer |
| Auth, PII, moderation, identity | `ecc:security-reviewer` | `security-review` |
| Any comment claiming a guarantee | `ecc:comment-analyzer` | — |
| An error path or a fallback | `ecc:silent-failure-hunter` | `error-handling` |
| Any UI | `ecc:a11y-architect` | `frontend-a11y`, `accessibility` |
| A user journey | `ecc:e2e-runner` | `e2e-testing`, `browser-qa` |
| A schema change | `ecc:database-reviewer` | `database-migrations` |
| A perf change | `ecc:performance-optimizer` | `benchmark` before AND after |
| Anything in the Expo client | — | `react-native-patterns` |
| Before a PR | — | `verification-loop`, then `/review` |
| Before a promotion | — | `production-audit` |
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

## 4b · The passes, in full

Each of these has run on this codebase and returned something. This is the brief
that made it work, not a description of the tool.

### Coverage — every change, no exception

`ecc:pr-test-analyzer`. Brief it with: the diff (`git diff origin/dev...HEAD`
**plus uncommitted work** — half the change is often not committed yet), the
named modules, and a pointer at `__tests__/negative-controls.json` so it knows
this project's standard. Ask it four things:

1. What can break with every test still green? Name the input, the path, the
   wrong output.
2. Which of my new tests would pass against broken code?
3. Which paths in the new code are untested — enumerate the branches.
4. Does the integration suite reach this at all?

Tell it to rank, and to prefer a short list of tests that catch real bugs over
coverage advice.

*Found:* a comment citing a test file that did not exist; `whenLabel` rendering
31 Dec → 2 Jan with no years; two integration assertions running as `0 >= 0`.

### Postgres and schema design

`ecc:database-reviewer`, having read `postgres-patterns` and `prisma-patterns`.
Brief it with the specific query paths (`app/dashboard/actions.ts`,
`lib/attention-queues-query.ts`, `lib/loop-closure.ts`, `lib/attendee-counts.ts`,
the mobile feed) and **the live database**:

```bash
docker exec blendn-pg17 psql -U postgres -d blendn_test -c "EXPLAIN (ANALYZE, BUFFERS) …"
```

Ask for: index coverage against the predicates *actually used* (a composite whose
leading column is unconstrained cannot be seeked); round-trip counts and
dependent-wave depth; unbounded `findMany` pulled into Node just to take
`.length`; N+1; FKs without a covering index; CHECK constraints in migration SQL
but not in `schema.prisma`; and any column rendered in the UI with no application
writer.

The seed is small, so tell it to read **plan shapes, not timings**, and to say
where row counts make a plan unrepresentative.

*Found:* two missing indexes on queries added the same week; the admin overview
holding 19 of 20 pool connections; three register entries that were stale.

### Latency and hot paths

`ecc:performance-optimizer`, having read `latency-critical-systems` and
`react-performance`. Do not let it collapse everything into "fast" — the skill's
method is p50/p95/p99, throughput, **freshness age**, queue depth, cache hit
rate, render time, and behaviour under failure.

The three hot paths here: the **live-ops socket tick** (`lib/live-snapshot.ts`,
every 5s per watched event), the **admin dashboard render** (every route
`force-dynamic`, no cache), and the **mobile discovery feed**. Give it the dev
server and `/tmp/blendn-dev.log`, which carries real `GET /dashboard 200 in
NNNms` lines.

Where it proposes a cache, make it state **the freshness bound and what goes
wrong past it**. On this product a stale occupancy number is worse than a slow
one — `lib/live-snapshot.ts` argues it at length, and the answer for the live
tick is *do not cache it at all*.

*Found:* two pure waterfalls in `buildAdminOverview`; `findMany`/`count`
serialised in two places; and a confirmation that the ops tick is healthy, with
the stale comment above it corrected.

### API contract

`api-design`, usually folded into the security pass since it reads the same
routes. The known state: the 64 mobile route files are **100% consistent** on
`lib/api-response.ts`, while **15 of 28 dashboard routes still return raw
strings** — two error contracts in one backend. Only 3 of 62 mobile routes use
`lib/pagination.ts`.

Ask specifically: which violations are worth fixing now versus recording, and
**who consumes the endpoint** — `e2e/__contracts__/mobile-api.json` is the
contract the Expo client holds, and a route absent from it has no client to
break.

### Security

`ecc:security-reviewer`. The rule from CLAUDE.md is the brief: authorization is
**organisation-shaped, never identity-shaped** — scope on `organizer_org_id` and
`venue.owner_org_id`, never on `events.organizer_id`. Point it at `lib/rbac.ts`
and ask whether any new list filter is **wider than the resolver** for any role.

*Found:* a sponsor could list their organisation's events — `eventPermissions`
denies them row by row and the list filter did not gate on role at all.

### Comment rot

`ecc:comment-analyzer`. This codebase has eighteen recorded comments describing
behaviour the code does not have, clustered in the safety and privacy code where
a reviewer is most likely to trust the comment instead of checking. Tell it to be
adversarial and to verify five things: any comment naming a file, test, function
or table; any asserting a guarantee; any describing a past bug; **any that would
defend the bug if the code were wrong** (the worst kind — it survives review);
and any quoting a number.

*Found:* two of my own comments giving different counts for the same incident.

### Design system and accessibility

`ecc:a11y-architect` / `frontend-a11y`, against `docs/DESIGN_SYSTEM.md`. The
rules that are actually enforced here: one `h1` per page (`site-header` owns it),
**exactly one `HeroMetric`** and one gradient element, hierarchy from type not
boxes, no card inside a card, container queries not viewport breakpoints, no raw
hex, empty says what will fill it, and charts are honest by construction — axes
at zero, zero draws as zero, **no cumulative series**.

Measure, do not eyeball: contrast through a canvas (oklch → sRGB is not a
lightness-to-luminance identity), 4.5:1 for text under 18.66px on
`--background` *and* `--card`.

*Found:* `--faint-foreground` at 3.99:1 and 3.67:1, on the nav group labels and
every table header — under AA on nearly every screen.

### E2E, against the seed

`ecc:e2e-runner` / `e2e-testing`. Drive real journeys, signed in, against
`seed:qa` — the fixture is designed for this and its shape is the point:

| Seeded | Why it is there |
|---|---|
| 4 admins, organiser, venue owner, sponsor, attendee | the 5 × 38 route matrix |
| `teen.tester@blendn.app`, under 18 | the age gate has something to refuse |
| 3 curated events — open / dead / claimed, **5 refusals on the dead one** | curation health, and the only refusal data in the product |
| Multi-day `design-week-bengaluru` | occurrences, and the person-days-vs-people trap |
| `saarbruecken-language-exchange` | a second country — the switch banner and the resume policy |
| `bandra-supper-club` | a second city, so the picker is testable at all |
| `monsoon-flea-market` (past), `diwali-rooftop-unannounced` (draft), `private-listening-session` | **negative** cases: a draft reaching an attendee is a leak, not a display bug |
| 11 RSVPs against 20 check-ins, one person in two events | no-show is a real number, and exactly one true repeat attendee |
| Pune: demand, zero events | the city the demand signal exists for |
| 0 pending flags, 4 claims, 7 applications | the exact state that made the overview print "Moderation queue is clear" |

The journeys worth driving end to end: **apply → onboarding queue → decide**;
**curated event → claim → decide**; **publish → check in → room → chat →
moderation queue**; and the **another-city** path. Each crosses both repos, so
each needs the Expo client as well as the dashboard.

### Driving the real thing — three tools, three jobs

`browse` screenshots and measures the DOM. It is the fast loop and it is not
enough on its own. Three more, each for something `browse` cannot see:

**Chrome DevTools MCP — the web app, below the DOM.** Console *and* network *and*
a real performance trace. Use it when the question is "why is this slow", "what
did it request", or "is this error mine".

```
navigate_page          → the URL, signed in
list_console_messages  → hydration mismatches, React warnings, 404s
list_network_requests  → waterfalls, duplicate fetches, payload sizes
performance_start_trace / performance_stop_trace → real LCP/CLS/long tasks
performance_analyze_insight → what the trace says to do about it
lighthouse_audit       → a11y and perf scores as a number that can regress
emulate / resize_page  → throttled CPU and network, which is where India ships
take_snapshot          → the a11y tree, which is what a screen reader actually gets
```

Telling *mine* from *already there* is the cheap move: remove the newest
component and reload. `/dashboard/events/new` reports a hydration mismatch that
survives that test, so it is the two Leaflet maps, not the change on top of them.

**Maestro MCP — the Expo client.** The dashboard is half the product; a journey
that ends at a check-in has to be driven on a phone.

```
list_devices    → ALWAYS first; every other local call needs its device_id
inspect_screen  → the view hierarchy, before targeting anything
run             → one full flow as inline YAML, not a string of single commands
```

**Both platforms, every time — iOS AND Android.** One simulator is not the
client. The product ships to both stores and has had Android-only defects, so
a journey driven only on the iPhone simulator is half-driven: run the same
flow on an Android emulator (`list_devices` shows both; boot one with
`emulator -avd …` if none is up) and read the row back from each. If Android
cannot be run, the §8 line says so — `Driven: iOS only — <reason>` — and the
ticket stays open.

Three facts that have each cost a run: the bundle id is
**`com.matryxsociallabs.blendn`** (not `com.blendn.app`), Maestro **text
selectors are full-string regex** — `"Check in"` does not match "Check in now"
— and if the MCP answers *"Device became unreachable"* on every call, its
driver session is dead: **restart the MCP** (kill the `maestro mcp` java
process; the harness respawns it) rather than falling back to the CLI, and
**open the Maestro Viewer** (`http://127.0.0.1:9999/`) before running flows so
the run can be watched. Also on iOS: a password field with
`textContentType="newPassword"` gets covered by the simulator's *Automatic
Strong Password* sheet — fill it first, before any keyboard is up, and verify
the value in `inspect_screen`.
Mobile flows declare `appId` and open with `launchApp`. Read `cheat_sheet`
before authoring anything unfamiliar.

**Playwright — the journeys that must not regress.** `e2e/` runs in CI on every
PR. It is where a journey goes once it has been driven by hand and works:
signup → onboarding → browse → RSVP → check in → room, and the four acquisition
funnels. Use the `e2e-testing` skill for page objects and flake strategy;
artefacts (screenshot, trace) upload on failure so a red CI run is readable
without rerunning it.

**Which to reach for**

| Question | Tool |
|---|---|
| Does it look right at 375/768/1440? | `browse` |
| Why is it slow / what did it fetch / is this error mine? | Chrome DevTools MCP |
| Does the journey work on a phone? | Maestro MCP |
| Will this journey still work next month? | Playwright in `e2e/` |
| Is the number on the screen the right number? | integration test against real Postgres |

---

## 4c · The rest of the toolbox

§4 is the fan-out that runs against a diff. These are the ones to reach for when
the *shape* of the problem calls for them, rather than on every change.

### API and contracts

| Skill | Reach for it when | Why here specifically |
|---|---|---|
| `api-design` | designing or reviewing any endpoint | Conventions: resource naming, status codes, pagination, error envelopes, versioning. Already in §4 as part of the security pass. |
| **`contract-first`** | a response shape changes, or a new endpoint gets a consumer | **The strongest fit in the catalogue for this product and the least used.** The Expo client is a separate repo on a separate release cycle, so field drift is not caught by a build — it is caught by an app in the store breaking. `e2e/__contracts__/mobile-api.json` is already the artefact this skill formalises. The rebuild plan's `RoomMember { memberId }` change is a breaking rewrite of every match, roster and reveal screen; that migration should be run through this. |
| `backend-patterns` | writing or reviewing a Next.js route and its data access | Route-layer patterns rather than schema. Pairs with `ecc:database-reviewer`, which looks below it. |

### Performance, beyond the latency pass

| Skill | Reach for it when | Why here specifically |
|---|---|---|
| **`benchmark`** | before and after any perf change | **Closes a gap SCRUM-40 (E15) has been carrying.** That epic asked for *"a repeatable benchmark rather than a one-off measurement"*, and every number this project has is a one-off. A baseline that a PR can regress against is the difference between "we measured it once" and "we would know". |
| `benchmark-methodology` | designing what to measure | Warm-up, variance, what a p95 on 17 seed rows is worth. Read it before trusting a number from this seed. |
| `benchmark-optimization-loop` | trying several implementations of one hot path | Recursive: measure, vary, measure. For the `buildAdminOverview` cache (SCRUM-73), where the question is which of three shapes is fastest, not whether to cache. |
| **`redis-patterns`** | touching the cache, the rate limiter, or a distributed counter | Redis already holds the spam windows and the rate limiter — both moved there because a per-process `Map` is per-replica and lost on deploy. The rebuild plan's R20 puts **impression counters** there next, on the hottest read in the product, so key design and TTL choice stop being incidental. |
| **`database-migrations`** | any schema change | Zero-downtime, rollback, and the Prisma specifics. This repo has a documented trap — `db:push` and `db:migrate` produce *different* schemas because `schema.prisma` cannot express a CHECK constraint, and three exist only in migration SQL — plus Railway applying migrations on boot, so a bad one takes the deploy down rather than failing a job. |
| `nextjs-turbopack` | dev-loop speed | Marginal, and real: the dev server's first compile of a heavy route is 8–10s, which is most of the wall-clock cost of driving a page. |
| `production-audit` | before a promotion, or "what breaks in prod?" | Pre-launch, local evidence only, nothing sent out. The natural companion to `verification-loop`: that one asks "does this work", this one asks "does this survive". |

### The mobile half

| Skill | Reach for it when |
|---|---|
| **`react-native-patterns`** | anything in `blendn/ashgabat` — Expo Router, state separation, list performance, NativeWind vs StyleSheet, secure storage |

The client's problems are structural rather than missing features (no primitives
layer, ~400 raw colour values, 73 files calling `StyleSheet.create`), so this is
the skill that governs the whole phase-2 plan, not one screen of it.

### Two that target failures this codebase actually has

| Skill | Reach for it when | The failure it names |
|---|---|---|
| **`click-path-audit`** | a control does something in more than one step | *"Functions individually work but cancel each other out."* That is K1.1 exactly — picking a venue moves the fence and the coordinates and not the pin, because two correct effects disagree. It is also G5: `checkAndAutoUnmute` clearing an organiser's manual mute, where two correct rules compose into a wrong one. |
| **`living-docs-governance`** | the docs and the code have drifted | Eighteen recorded comments describing behaviour the code does not have, a 200KB plan register measured at **one stale entry in eight**, and two documents that had to be merged because they covered the same thing. `ecc:comment-analyzer` finds instances; this is the systemic answer. |

### Cost

`cost-aware-llm-pipeline` — OpenAI moderation runs on the message path, so spend
scales with room activity rather than with users. Worth a pass before launch:
model routing by severity, and whether the deterministic checks can shed load
before the model sees it.

### Deliberately not here

Naming them so the list stays a list rather than becoming the catalogue:

- `data-throughput-accelerator` — no ingestion, backfill or ETL at a size where
  it pays. Revisit if the `product_events` rollups grow one.
- `content-hash-cache-pattern` — nothing here reprocesses files repeatedly. The
  cover-image thumbnail work is the one candidate, and it is not built.
- `kubernetes-patterns`, `docker-patterns` — Railway. `docker-patterns` matters
  only for the local Postgres, which is four lines in §5.
- Every `django-*`, `laravel-*`, `springboot-*`, `quarkus-*`, `kotlin-*`,
  `swift-*`, `rust-*`, `golang-*` — wrong stack.
- `eval-harness`, `mle-workflow`, `rag-pipeline-reviewer` — no model being
  trained or retrieved against. The OpenAI call is a single classification.

---

## 8 · Driving the journey — the step that decides whether it counts

**This runs after the specialists, on both surfaces, and it is what closes a
ticket.** Not because it is ceremony: because it is the only step that has ever
caught the defects this product actually shipped.

| Shipped defect | Caught by |
|---|---|
| Onboarding never wrote `user_interests`, so finishing it left you unable to post on the board | driving the app, then `SELECT count(*) FROM user_interests` |
| "Maybe later" left `push_enabled` at `true` for somebody who said no | driving the app, then reading the column |
| Push tokens survived sign-out, so the next person on the phone got the previous user's DM previews | driving two sign-ins on one device |
| A curated event's host was the founder who curated it | opening the event on a phone |

Every one passed `tsc`, the unit suite, the integration suite and a screenshot.

### What it is, per surface

**Client (`blendn/ashgabat`) — Maestro MCP.**

```
list_devices     → ALWAYS first; every other local call needs its device_id
inspect_screen   → the view hierarchy, before targeting anything
run              → one full flow as inline YAML, not a string of single commands
```

**Both platforms, every time — iOS AND Android.** One simulator is not the
client. The product ships to both stores and has had Android-only defects, so
a journey driven only on the iPhone simulator is half-driven: run the same
flow on an Android emulator (`list_devices` shows both; boot one with
`emulator -avd …` if none is up) and read the row back from each. If Android
cannot be run, the §8 line says so — `Driven: iOS only — <reason>` — and the
ticket stays open.

Three facts that have each cost a run: the bundle id is
**`com.matryxsociallabs.blendn`** (not `com.blendn.app`), Maestro **text
selectors are full-string regex** — `"Check in"` does not match "Check in now"
— and if the MCP answers *"Device became unreachable"* on every call, its
driver session is dead: **restart the MCP** (kill the `maestro mcp` java
process; the harness respawns it) rather than falling back to the CLI, and
**open the Maestro Viewer** (`http://127.0.0.1:9999/`) before running flows so
the run can be watched. Also on iOS: a password field with
`textContentType="newPassword"` gets covered by the simulator's *Automatic
Strong Password* sheet — fill it first, before any keyboard is up, and verify
the value in `inspect_screen`.
**Android, specifically — the emulator is slow only when it is misconfigured.**
Six facts from the first Android run, each of which cost an hour:

- The AVD was on **SwiftShader** (software GPU). Boot it with
  `emulator -avd Medium_Phone -gpu host -feature -Vulkan`; the `-Vulkan` is
  because gfxstream throws `EGL_BAD_ATTRIBUTE` video artefacts on this Mac.
  `ramSize=2560`, 2 cores in `config.ini`; **4 GB was worse** (host swap).
  Shut the iOS simulator and never run Gradle at the same time.
- Gradle needs **JDK ≤ 23**: `brew install openjdk@21` and
  `JAVA_HOME=/opt/homebrew/opt/openjdk@21`.
- `launchApp` with `stopApp: true` on a dev build lands on *"Unable to load
  script"* because the dev launcher has no Metro URL: go to the launcher home
  and tap `http://10.0.2.2:8081`.
- `inputText` with a long string times out (`DEADLINE_EXCEEDED`). Short strings,
  and `hideKeyboard` between fields.
- A 3-button `Alert` renders **neutral / negative / positive** by index and
  ignores `style: 'cancel'`, so the button order a flow taps is per-platform —
  `lib/photoUtils.ts alertButtons()` in the client owns that.
- `expo-image-picker@16.1.4` crashes natively on the Android 16 photo picker
  (`FailedToDeduceTypeException`); the fix is a `patch-package` patch under
  `patches/` applied on `postinstall`. A checkout where that has not run will
  crash on the first library pick.

**Push, specifically — a toggle is not tested until a push was sent.**
`Device.isDevice` is false on every simulator and emulator, so the client
registers a **fake token** there and nothing can arrive. Prove the opt-out on
the server (`__tests__/integration/push-opt-out.itest.ts` runs the real sender
with Expo mocked) and then deliver one real push to a real phone through a real
path — editing an event the account has RSVP'd to sends `event_update` — and
read `notifications` back. Android additionally needs FCM
(`google-services.json`), which the client does not ship yet, so Android push is
`not driven — no FCM config` until it does.

Mobile flows declare `appId` and open with `launchApp`. Read `cheat_sheet`
before authoring anything unfamiliar. `run_on_cloud` when a real device matters;
`list_cloud_devices` returns valid `{device_model, device_os}` pairs and they
must be passed verbatim, never reformatted.

**Dashboard (`blendn-admin/seville`) — driven, then Playwright.**

Drive it first with `browse` or Chrome DevTools MCP, signed in, against the seed.
Once a journey works by hand and matters, it goes into `e2e/` as a Playwright
spec so CI runs it on every PR — use the `e2e-testing` skill for page objects and
flake strategy.

**Both — read the database back.**

```bash
docker exec blendn-pg17 psql -U postgres -d blendn_test -c "SELECT …"
```

An API 200 proves the route returned. It does not prove the row was written, and
it does not prove the number an admin is sold moved. That gap is where
`profiles.onboarded` lived for months: the column existed, the funnel counted it,
and nothing had ever set it.

### The journeys, and which surfaces each crosses

| Journey | Client | Dashboard | Read back |
|---|---|---|---|
| Signup → onboarding → profile | Maestro | Users list, funnel | `profiles`, **`user_interests`**, `push_enabled`, `share_location` |
| Apply → queue → decide | — | `/apply`, `/dashboard/onboarding` | `organiser_onboarding_requests`, `organisations`, `User`, `organisation_members` |
| Curated event → claim → decide | — | `/claim/[id]`, `/dashboard/claims` | `event_claims`, `events.organizer_org_id` |
| Publish → check in → room → chat → moderation | Maestro, mocked location | `/dashboard/events/[id]` live tab, `/dashboard/moderation` | `event_check_ins`, `check_in_refusals`, `chat_messages`, `moderation_flags` |
| Another city | Maestro | `/dashboard` Cities | `city_demand` |

The seed is built for these — see §4b's fixture table. It already carries the
under-18 tester, the dead curated event with five refusals, the multi-day event,
the second city and the second country, and the draft that must never reach an
attendee.

### The rule about negative cases

Drive the refusal, not only the happy path. Both onboarding bugs were found by
**taking the decline branch** — "Maybe later" on a permission screen, which is
the path nobody demos. A field that always writes `true` passes a truthy check
either way, which is why the standard here is asserting the specific value.

### When it genuinely cannot run

Say so, name what is missing, and **leave the ticket open**. SCRUM-54 does this
properly: it records that the Expo client UI could not be driven because the
session had no device, and every child ticket states which layers it covered, so
a green board is never mistaken for more coverage than was taken.

"Not driven" is a result. Silently not driving is how a ticket closes on a fix
nobody watched work.

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
- `browse` refuses `file://` and screenshot paths outside the repo or
  `/private/tmp`. Serve the mockup instead — `python3 -m http.server 8765` from
  its design directory — and screenshot to `/private/tmp`, then copy back.
  Chrome DevTools MCP can only save screenshots inside the workspace; omit
  `filePath` and read the inline image.
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

### Open, recorded rather than fixed

Latent or pre-existing, and each one belongs to its own change rather than to
whatever diff happened to find it:

- The admin dashboard's first wave holds **19 concurrent queries against a pool
  of 20**, so one dashboard load and a live-ops tick can contend. Measured as a
  count, not reproduced under load. The fix is a short-TTL cache.
- **No GIN index** for the mobile feed's four-column `ILIKE` search; `pg_trgm` is
  available and not enabled.
- The city rollup is an unbounded `findMany` folded in Node.
- `coordinateCache` in `lib/location.ts` has no TTL and no size cap, beside a
  bounded cache in the same file.
- **15 of 28 dashboard API routes return raw strings** where the mobile side is
  100% consistent on the envelope.
- `/dashboard/events/new` reports a **hydration mismatch** from its two Leaflet
  maps. Confirmed pre-existing by removing the newest component and watching it
  survive — which is the cheap way to tell "mine" from "was already there".

### The chain itself, skipped three times

Recorded because it is the same failure as the rest of this section, and the
worst one: the check was available, and it was not run.

`ecc dashboard-builder` ran on the overview, the create-event form and the
applications queue. `ecc frontend-design-direction` and `/design-html` ran on the
overview **only**. On the other two the reasoning was "the direction is already
locked" and "this is not a new composition" — both true, and neither a reason.

The cost is measurable rather than theoretical. Step 1 alone, run properly on the
applications queue, found that the strongest disqualifier in the queue (a
ticketing-platform email domain) and the strongest credential (the applicant's
own domain) were rendering in the same filled badge. Steps 2 and 3 were skipped
on that screen, so whatever they would have found is unknown — which is the
point. A skipped check produces no evidence that it was safe to skip.

§1 is now written as a procedure with an artefact per step and a gate before the
first edit, because the previous version was a description and descriptions are
negotiable.

---

And three guards that did not catch what they existed for, because each looked
only where the last bug was: the `"use server"` guard (hardcoded three
filenames), the double-`h1` ratchet (read `page.tsx` only, missed an `h1` one
import away), and `authz-scoping-boundary` (catches a comparison, not a where
clause). **A guard that only looks where the last bug was is not a ratchet.**
