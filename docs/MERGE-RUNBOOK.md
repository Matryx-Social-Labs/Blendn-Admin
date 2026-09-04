# Landing the audit stack

Nineteen PRs, verified as a single merged tree against a real Postgres before
any of them landed. This is what that dry run found.

**Every branch merges and the combined result is green** — 1691 unit tests, 185
integration tests, `tsc` clean, `build:server` clean, lint clean. It does not
merge *unassisted*: there are three conflicts and one reconciliation, and all
four are recorded below with their resolutions.

None of this is visible from any single PR, which is why it was worth doing.

## Order

```
#264 → #265 → #266 → #267 → #268 → #270 → #269
     → #271 → #272 → #273 → #274 → #275 → #276
     → #277 → #278 → #279 → #280 → #281 → #282
```

`#270` before `#269` is deliberate: `#269`'s ratchet is checked in **both**
directions, so it has to see the code that makes its allowlist entries stale.

`#271`–`#281` are one linear stack and will fast-forward past each other.
`#282` is independent.

## The three conflicts

### 1. `#274` vs `#268` — `app/api/events/route.ts`, `app/api/events/[id]/route.ts`

Both add a block to the same create/update path: `#268` resolves the owning
organisation and the unique slug, `#274` resolves the city at write time.

**Resolution: keep both.** Neither replaces the other. Two things to watch —
the conflict boundary cuts *inside* a shared `/*` opener, so the second block
loses its comment start and has to be re-opened; and both sides import from
`@/lib/geofence-input`, so `validateLocationInput` ends up declared twice.

### 2. `#275` vs `#278` — `lib/live-snapshot.ts`

Adjacent imports (`escalates`, `resolveOccurrence`). Keep both.

### 3. `#276` vs `#265` — `lib/socket-server.ts`, `server.ts`

The substantive one. `#276` moves the sweepers out of `initSocketServer` into
`lib/background.ts`; `#265` adds a **fourth** sweeper (`notification-retention`)
to the old location. Neither PR can see the other's half.

**Resolution: take `#276`'s structure and fold the fourth sweeper into it** —
which is exactly what `lib/background.ts` exists for. Keep `#265`'s
`import { db }` in `server.ts`; the naive resolution drops it and `$disconnect()`
breaks.

## The reconciliation

Four changes that are only correct **after** the merges, so they cannot live in
any branch. Apply as one commit on top.

### `__tests__/server-actions-reachable.test.ts` — drop three entries

`canPublish`, `notifyEventCancelled` and `notifyEventDetailsChanged` are
allowlisted as unreachable. `#265` and `#268` wire all three up, and the ratchet
checks staleness in both directions, so the entries now fail. Delete the lines.

### `__tests__/negative-controls.json` — add eleven entries

Every structural guard added across `#266`–`#282`. The controls were all run and
are recorded in the commit messages; the registry lives on `#265`, so no branch
could add its own entry.

### `lib/notification-retention.ts` — self-schedule

`#265` writes it with `setInterval(() => void runSweep(), …)`. `#282` bans that
pattern across `lib/`. Neither PR can see the conflict: the guard doesn't exist
yet on `#265`, and the file doesn't exist on `#282`'s base.

It is also the sweeper most able to outlast its own interval — it deletes in
batches of 5,000 and takes locks on a table every notification-bell read touches,
so `setInterval` would start the next pass on top of it and take the same locks
twice. Reschedule from a `finally`, matching the other three.

### `__tests__/no-async-setinterval.test.ts` — a fourth sweeper

The recovery assertion names three. There are four.

## Verifying it yourself

The integration suite needs a real Postgres and is the half that caught the one
genuine regression in this stack:

```bash
docker run -d --name blendn_itest \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=blendn_test \
  -p 55432:5432 postgres:16

export DATABASE_URL="postgresql://postgres:postgres@localhost:55432/blendn_test"
npm run db:migrate
npm run test:integration
```

**`db:migrate`, not `db:push`** — this said `db:push` and that is a weaker
database than the one you are testing for. `schema.prisma` cannot express a
CHECK constraint or a partial unique index, so `db push` creates none, while
three CHECKs and `presence_sessions_one_open_per_occurrence` exist in migration
SQL and therefore in every deployed environment.

That index is what stops two concurrent check-ins opening two open sessions for
one person, which is occupancy counting one body twice — the exact failure the
sessions model exists to remove. A `db push` database has no such index, so the
suite would pass while the invariant it depends on was absent.

`__tests__/integration/*.itest.ts` only runs in CI otherwise, so a change that
breaks it leaves the local 1691 green. That is how `MASS_CHECKOUT_FLOOR` shipped
in `#278` with an integration test still encoding the old behaviour.
