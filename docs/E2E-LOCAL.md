# E2E runs locally, not in CI

```bash
DATABASE_URL=postgres://…/scratch npm run test:e2e:local
```

That is the whole thing. It migrates, seeds, builds, starts the production
server, waits for health, runs Playwright, and stops the server — including on
Ctrl-C.

One spec: `npm run test:e2e:local -- e2e/venue-pin.spec.ts`.

## Why it is not in CI

**The suite is not broken.** It passes: 32 tests, including the two exhaustive
sweeps that walk 27 dashboard pages at three widths and 30 routes as five
roles.

What fails is the environment. Measured on 2026-09-03, streaming memory into
the step log because nothing downstream of the failure survives:

```
13:12:19  top: 2952M <- node dist/server.js
13:12:34  top: 5755M <- node dist/server.js
13:12:50  top: 6771M <- node dist/server.js   avail=72M
##[error]The runner has received a shutdown signal.
```

`node dist/server.js` reaches **6.7 GB** on a 2-core / 7.9 GB hosted runner —
the smaller one a private repository gets — and the host reclaims the machine.
Tests pass right up to the moment it dies: 26 to 29 of them, zero failures, on
every run.

Three things are established:

- **It is not the V8 heap.** `--max-old-space-size=1536` was in force, so the
  growth is external — Buffers, native allocations, or allocator arenas.
- **It does not reproduce locally.** The same production build served four
  consecutive full suite runs at 344 MB → 511 MB, then flat.
- **It is not the browser.** Chromium measured 193 MB on CI; the Playwright
  runner peaks at 326 MB locally with `CI=1`.

It is also **not** the Actions quota or a spending limit, both of which were
blamed before anything was measured. September usage was 38 minutes, all of it
from another repository.

A lane that is red on every push is worse than no lane: people learn to ignore
the cross, and then miss the real one. So the job is gated rather than deleted.

## Re-enabling it

Add the `full-e2e` label to a pull request. Nothing else changed — the job is
intact, including the diagnostics that produced the numbers above.

Making it green again means deleting one `if:` in `.github/workflows/ci.yml`.
That should wait until the memory question is answered, because the answer may
matter more than the lane: **Railway runs the same long-lived process, and
nothing restarts it between runs.** If this is a genuine external-memory leak
rather than an artefact of a small runner, production has it too.

`MEMORY_TRACE=1` makes the server report `heapUsed`, `external`, `arrayBuffers`
and the unaccounted remainder every five seconds, which is what distinguishes
the two.

## What replaces the CI signal meanwhile

Nothing automatic — that is the cost of this decision, and it is worth stating
plainly rather than discovering later. The e2e suite is the only coverage for
the dashboard rendering at all, for role access across 38 pages, and for the
check-in geofence end to end. It has to be run by hand before anything touching
those lands.

`lint-and-types`, `test` (2161 unit + 218 integration against real Postgres)
and `build` still run on every push.
