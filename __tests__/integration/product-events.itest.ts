import {
  PRODUCT_EVENTS,
  activeSince,
  dayKey,
  flushProductEvents,
  record,
  resetProductEventCache,
} from "@/lib/product-events"
import { pruneProductEvents } from "@/lib/notification-retention"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/**
 * The event stream, and the unique index that replaces an outbox.
 *
 * ## Why this is an integration test
 *
 * The whole design rests on `dedupe_key` being unique **in the database**. A
 * unit test with a mocked client cannot tell a working `ON CONFLICT DO NOTHING`
 * from one that silently inserts twice, and inserting twice is not an error
 * anybody would see — it is a DAU figure quietly reading double.
 *
 * That is the same class as the two Prisma facts this project has already paid
 * for: a `not` that excludes NULLs, and a `P2002` whose constraint name is not
 * in the message. Both read correctly through the client and were false in the
 * database.
 */

const users: string[] = []

afterAll(async () => {
  if (users.length) {
    await db.product_events.deleteMany({ where: { user_id: { in: users } } })
  }
  await cleanup(users, [])
  await closeDb()
})

beforeEach(resetProductEventCache)

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  return id
}

/**
 * Record and force the write.
 *
 * `record` buffers and returns — it does not touch the database, which is the
 * whole point: it sits on the path of every authenticated request. A test that
 * asserts on rows has to flush, and `flushProductEvents` returns the flush
 * already in progress rather than a bare 0, so this is deterministic whether or
 * not the ten-second window happened to elapse.
 */
async function emit(input: Parameters<typeof record>[0]) {
  record(input)
  await flushProductEvents()
}

const rowsFor = (userId: string) =>
  db.product_events.findMany({ where: { user_id: userId }, select: { name: true, dedupe_key: true } })

describe("recording a signal is safe to repeat", () => {
  it("writes one row however many times the app is opened", async () => {
    /*
     * THE assertion. A person opening the app forty times is one active person,
     * and the alternative — a row per request — makes "active this week" a
     * measure of how often the client re-fetches.
     *
     * The cache is cleared between the two calls, so this proves the DATABASE
     * refused the second write rather than the process remembering it. Without
     * that reset the test would pass against a table with no unique index at
     * all, which is exactly the vacuous shape this project keeps producing.
     */
    const user = await person("pe-open")

    await emit({ name: PRODUCT_EVENTS.app_opened, userId: user })
    resetProductEventCache()
    await emit({ name: PRODUCT_EVENTS.app_opened, userId: user })

    expect(await rowsFor(user)).toHaveLength(1)
  })

  it("separates days, so the same person counts once per day", async () => {
    const user = await person("pe-days")
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)

    await emit({ name: PRODUCT_EVENTS.app_opened, userId: user })
    resetProductEventCache()
    await emit({ name: PRODUCT_EVENTS.app_opened, userId: user, at: yesterday })

    const rows = await rowsFor(user)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(2)
  })

  it("separates entities, so two events viewed are two rows", async () => {
    const user = await person("pe-entities")
    const a = "11111111-1111-1111-1111-111111111111"
    const b = "22222222-2222-2222-2222-222222222222"

    await emit({ name: PRODUCT_EVENTS.event_viewed, userId: user, entityKind: "event", entityId: a })
    await emit({ name: PRODUCT_EVENTS.event_viewed, userId: user, entityKind: "event", entityId: b })
    resetProductEventCache()
    // The same event again on the same day is still one view.
    await emit({ name: PRODUCT_EVENTS.event_viewed, userId: user, entityKind: "event", entityId: a })

    expect(await rowsFor(user)).toHaveLength(2)
  })

  it("survives two replicas racing, because the index does the work", async () => {
    /*
     * Two processes, one person, one day — the case an outbox with a dispatcher
     * would have been built to handle. `ON CONFLICT DO NOTHING` handles it with
     * no worker, no retry queue and no lag metric to forget to build.
     *
     * Separate caches, issued together, so both reads happen before either
     * write lands.
     */
    const user = await person("pe-race")
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        resetProductEventCache()
        await emit({ name: PRODUCT_EVENTS.app_opened, userId: user })
      })
    )
    expect(await rowsFor(user)).toHaveLength(1)
  })

  it("drops a signal from somebody not signed in", async () => {
    /*
     * An anonymous signal cannot be deduped by person, so it would collapse
     * every signed-out browser into one row per day and call it one person. A
     * count wrong by an unknowable factor is worse than one that admits it
     * covers only signed-in people.
     */
    const before = await db.product_events.count()
    await emit({ name: PRODUCT_EVENTS.feed_browsed, userId: null })
    expect(await db.product_events.count()).toBe(before)
  })

  it("never throws, on either half, because analytics must not fail a request", async () => {
    /*
     * Both halves, because they fail differently and both are on a path a user
     * is waiting on. `record` is synchronous and must not throw into a request
     * handler; the flush hits a real foreign-key violation for a user id that
     * does not exist, and must swallow it rather than reject an unawaited
     * promise — which in Node is an unhandled rejection and, depending on
     * flags, the end of the process.
     */
    expect(() =>
      record({ name: PRODUCT_EVENTS.app_opened, userId: "no-such-user-fk-violation" })
    ).not.toThrow()

    await expect(flushProductEvents()).resolves.toBe(0)
  })
})

describe("active this week", () => {
  it("counts people, not person-days", async () => {
    /*
     * One row per person per day means a seven-day window gives one person up
     * to seven rows. Counting rows would report a single loyal user as seven
     * active people — the row-versus-person defect W17 fixed in nine places,
     * arriving in a new table on its first day.
     */
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    /*
     * The baseline is taken BEFORE the multi-day person exists, and their three
     * days are added afterwards, so the delta is that one person's whole
     * contribution.
     *
     * A first version added a *second* person after the baseline and asserted
     * the delta was 1 — which is true whether you count rows or people, since
     * one new person contributes one of each. The control caught it: replacing
     * the distinct query with a row count left the test green. A test that
     * cannot distinguish the two things in its own title is worse than none.
     */
    const before = await activeSince(since)

    const user = await person("pe-week")
    for (let day = 0; day < 3; day++) {
      resetProductEventCache()
      await emit({
        name: PRODUCT_EVENTS.app_opened,
        userId: user,
        at: new Date(Date.now() - day * 24 * 60 * 60 * 1000),
      })
    }
    // Three rows, one person.
    expect(await rowsFor(user)).toHaveLength(3)

    const after = await activeSince(since)
    expect(after.count - before.count).toBe(1)
    expect(after.source).toBe("app_opens")
  })

  it("says which signal it used when there is none", async () => {
    // A window with nothing in it must not read as "nobody is active".
    const far = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    expect(await activeSince(far)).toEqual({ count: 0, source: "none" })
  })
})

describe("retention", () => {
  it("prunes past the window and keeps what is inside it", async () => {
    const user = await person("pe-prune")
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)

    await emit({ name: PRODUCT_EVENTS.app_opened, userId: user, at: old })
    resetProductEventCache()
    await emit({ name: PRODUCT_EVENTS.app_opened, userId: user })

    expect(await rowsFor(user)).toHaveLength(2)
    await pruneProductEvents()

    const left = await rowsFor(user)
    expect(left).toHaveLength(1)
    expect(left[0].dedupe_key).toContain(dayKey(new Date()))
  })
})

describe("the index the whole design rests on", () => {
  it("is unique on dedupe_key, in the database", async () => {
    /*
     * Everything here — retries being free, two replicas racing, a person
     * opening the app forty times counting once — is one unique index. The
     * behaviour tests above would all pass against a table with no index at all
     * if the per-process cache happened to absorb the duplicates, so this
     * asserts the constraint itself.
     *
     * `schema.prisma` declaring `@unique` is not evidence: it says what should
     * exist, and this project has already shipped a database missing three
     * CHECK constraints the schema could not express.
     */
    const rows = await db.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'product_events' AND indexname = 'product_events_dedupe_key_key'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toContain("UNIQUE")
  })
})
