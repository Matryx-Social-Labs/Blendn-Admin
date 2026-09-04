# Running the e2e suite locally

```bash
DATABASE_URL=postgres://…/scratch npm run test:e2e:local
```

That is the whole thing. It migrates, seeds, builds, starts the production
server, waits for health, runs Playwright, and stops the server — including on
Ctrl-C. One spec: `npm run test:e2e:local -- e2e/venue-pin.spec.ts`.

Add `MEMORY_TRACE=1` and the server's own memory breakdown is teed to stdout
every five seconds. Without that flag it goes to a temp file that nobody opens.

## It also runs in CI

Every PR, sweeps excluded. Nightly and on a PR labelled `full-e2e`, everything
— the two sweeps walk 27 pages at three widths and 30 routes as five roles,
231 navigations, and that is most of the lane's cost. A manual
`workflow_dispatch` runs the full sweep too, on the grounds that dispatching it
is already a deliberate act.

## The 6.7GB, and what it actually was

Recorded because the conclusion was wrong three times, and each wrong version
was written down with more confidence than the evidence supported.

The lane was reclaimed by the host mid-run, every run, at ~6.7GB RSS. It was
blamed on the Actions quota twice. Then it was measured — `node dist/server.js`
really was at 6,904M on a 2-core / 7.9GB runner — and written up here as an
unexplained external-memory leak, with a closing warning that **Railway runs
the same long-lived process, so production probably had it too**.

It did not. `npm run` does not set `NODE_ENV`, and nothing else in the workflow
did, so the step named "Start the production server" — in a job whose header
said it ran against the production server — started Next.js in **development
mode**. The server said so in its own startup log, `NODE_ENV: undefined`, on
every run, and nobody read that line for weeks.

Next.js dev compiles routes on demand and holds the module graphs. 231
navigations over 27 pages is what 6.5GB looks like.

```
                     peak RSS   handles                      result
development mode      6,904M    170  [FSWatcher:167]         reclaimed mid-run
production mode         458M     21  [Socket:20, Server:1]   29 passed in 15.7s
```

Railway sets `NODE_ENV`. Production was never on this code path; the lane was
the only place that server ran.

### Why it took so long

Three things each looked like evidence for a leak and were evidence of the
opposite:

- **"It doesn't reproduce locally"** was the answer, read as noise.
  `scripts/e2e-local.ts` passes `NODE_ENV: "production"` on the spawn. The two
  paths meant to run the same server differed by the one variable that decides
  which server runs.
- **"It is not the V8 heap, so the growth is external"** was written up as
  established fact. It was a disjunction inferred from `--max-old-space-size`
  holding, and two-thirds of it was false: at 6,496M RSS, `external` was 13M
  and `arrayBuffers` 6M.
- **The instrument reported nothing and that was not treated as a problem.**
  `MEMORY_TRACE=1` streamed to stdout specifically so it would survive a
  reclaimed runner — but the server is backgrounded inside the start step, and
  GitHub collects a background process's output only while the step owning the
  pipe is alive. That step exits when the health check passes. A twelve-minute
  run produced exactly one sample, at t+5s. It now writes to a file that the
  E2E step tails live.

The measurement that ended it, once the trace could be read at all:

```
rss=1357M heapUsed=199M external=18M unaccounted=1110M handles=199 [FSWatcher:167]
rss=6496M heapUsed=326M external=13M unaccounted=6073M handles=170 [FSWatcher:167]
```

Handles *fall* while RSS quintuples, so not leaked connections. Threads flat,
so not worker isolates. `external` 13M, so not Buffers. 167 filesystem
watchers in a server that should watch nothing is the tell — and the handle
breakdown was added only after the four original numbers had been exhausted.

`__tests__/e2e-server-mode.test.ts` fails the build if the start step loses
`NODE_ENV=production`. It reads the env prefix, not the file, so a comment
mentioning the variable does not satisfy it.
