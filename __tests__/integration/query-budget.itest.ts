import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { signAccessToken } from "@/lib/mobile-auth"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * The repeatable benchmark — E15's deliverable.
 *
 * ## Why it counts queries and not milliseconds
 *
 * A wall-clock benchmark on a shared CI runner measures the runner. It is noisy
 * enough to need a wide threshold, and a threshold wide enough not to flake is
 * wide enough to miss the regressions worth catching — so it gets an
 * `--ignore` and then gets deleted. The register already warns that its own
 * performance numbers are static analysis "except where marked", and a flaky
 * timing gate would be worse than that: an authoritative-looking number nobody
 * trusts.
 *
 * Round trips are deterministic. The same code against the same fixture issues
 * the same number of queries on any machine, at any load, every time. And they
 * are what the findings in this epic are actually about — ten round trips per
 * ops tick, an N+1 on unread counts, a roster read whole to render one page.
 * None of those is a slow *query*; each is too *many* queries.
 *
 * ## The assertion that matters
 *
 * Not the absolute count — that is a ratchet, and useful, but it moves for
 * legitimate reasons. The one that catches real regressions is **the count must
 * not grow with the data**. A route that costs the same for a room of three and
 * a room of fifteen has no N+1 in it; a route whose cost tracks room size has
 * one, whatever its absolute number happens to be that week.
 *
 * That property is also what the fix in `374326e` established, and nothing
 * pinned it until now: both room reads loaded every `chat_group_members` row to
 * render one page, so their cost grew with the room while the need did not.
 *
 * ## How the counting works
 *
 * `lib/db.ts` exports a Proxy that resolves `globalThis.prisma` on **every
 * access**, lazily. So an instrumented client assigned to that global is picked
 * up by already-imported route modules, with no mocking and no change to
 * production code — the routes run against real Postgres exactly as they would
 * in CI, and every operation they issue is recorded on the way through.
 */

interface Recorded {
  calls: string[]
  /** Rows returned per operation, same order as `calls`. */
  rows: number[]
  reset(): void
}

let base: PrismaClient
let recorder: Recorded
let previousGlobal: PrismaClient | undefined

beforeAll(() => {
  previousGlobal = globalThis.prisma
  base = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })

  const calls: string[] = []
  const rows: number[] = []
  const counting = base.$extends({
    query: {
      async $allOperations({
        model,
        operation,
        args,
        query,
      }: {
        model?: string
        operation: string
        args: unknown
        query: (a: unknown) => Promise<unknown>
      }) {
        calls.push(`${model ?? "raw"}.${operation}`)
        const result = await query(args)
        /*
         * Rows as well as round trips, and a recorded control is why.
         *
         * Counting calls alone catches an N+1 and is blind to the opposite
         * mistake: one query that reads far too much. Reverting the roster
         * lookup to `where: { chat_group_id }` — the exact regression this
         * benchmark was written alongside — left every call-count assertion
         * green, because reading three members and reading three hundred are
         * both one query.
         *
         * That is the cheaper failure to make and the harder one to see: it
         * never shows up as a slow query in a log, only as a route that gets
         * gradually heavier as rooms fill.
         */
        rows.push(Array.isArray(result) ? result.length : 0)
        return result
      },
    },
  })

  globalThis.prisma = counting as unknown as PrismaClient
  recorder = {
    calls,
    rows,
    reset: () => {
      calls.length = 0
      rows.length = 0
    },
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupMessagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/mobile/events/route") as
  typeof import("@/app/api/mobile/events/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  /*
   * One hook, and the order inside it is the point. Two `afterAll`s — one
   * disconnecting the instrumented client, one deleting fixtures through the
   * helper client — raced to "Cannot use a pool after calling end on the pool":
   * the disconnect ran first and the cleanup then queried a closed pool.
   */
  if (events.length) {
    const groups = await db.chat_groups.findMany({
      where: { event_id: { in: events } },
      select: { id: true },
    })
    const ids = groups.map((g) => g.id)
    if (ids.length) {
      await db.chat_messages.deleteMany({ where: { chat_group_id: { in: ids } } })
      await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: ids } } })
      await db.chat_groups.deleteMany({ where: { id: { in: ids } } })
    }
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })

  globalThis.prisma = previousGlobal
  await base.$disconnect()
  await closeDb()
})

/**
 * A live room with `members` people, of whom `speakers` have said something.
 *
 * The split is the whole point, and the first version did not have it: every
 * member spoke, so a fifteen-person room genuinely had fifteen distinct senders
 * on the page and the roster lookup read fifteen rows *correctly*. That fixture
 * cannot tell "reads the whole room" apart from "reads the page", because in it
 * they are the same set.
 *
 * With most members silent the two come apart, and the assertion becomes the
 * one worth making: cost tracks the page, not the room.
 */
async function room(members: number, speakers = members) {
  const owner = await makeUser(testId("qb_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("qb"),
      title: `Budget ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now - HOUR),
      end_time: new Date(now + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  const group = await db.chat_groups.create({
    data: { event_id: event.id, name: "room", status: "active" },
  })

  const people = []
  for (let i = 0; i < members; i++) {
    const id = await makeUser(testId(`qb_${i}`))
    users.push(id)
    const u = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: id, anonymous_name: `Pseudo ${i}` },
    })
    if (i < speakers) {
      await db.chat_messages.create({
        data: { chat_group_id: group.id, user_id: id, content: `hello ${i}` },
      })
    }
    people.push({ id, token: signAccessToken(id, u.email) })
  }
  return { groupId: group.id, people }
}

interface Measured {
  calls: string[]
  /** Total rows the request pulled out of Postgres. */
  rows: number
  /** Rows read by operations against one model. */
  rowsFrom(prefix: string): number
}

/** Run a request with a clean counter and return what it cost. */
async function measure(run: () => Promise<Response>): Promise<Measured> {
  recorder.reset()
  const res = await run()
  expect(res.status).toBe(200)
  const calls = [...recorder.calls]
  const rows = [...recorder.rows]
  return {
    calls,
    rows: rows.reduce((a, b) => a + b, 0),
    rowsFrom: (prefix) =>
      calls.reduce((total, call, i) => (call.startsWith(prefix) ? total + rows[i] : total), 0),
  }
}

const readRoom = (groupId: string, token: string) =>
  groupMessagesRoute.GET(
    new NextRequest(`http://localhost/api/mobile/chat/groups/${groupId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ chatGroupId: groupId }) }
  ) as unknown as Promise<Response>

describe("the query counter itself", () => {
  it("records the operations a route issues", async () => {
    /*
     * The control, and it is the whole file's foundation: every assertion below
     * is a *comparison* of counts, and two equal numbers are also what a
     * recorder that has stopped recording produces. Zero equals zero.
     */
    const small = await room(2)
    const { calls, rows } = await measure(() => readRoom(small.groupId, small.people[0].token))

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some((c) => c.startsWith("chat_messages."))).toBe(true)
    // Rows too, or every row assertion below compares zero against zero.
    expect(rows).toBeGreaterThan(0)
  })
})

describe("cost does not grow with the room", () => {
  it("reads a page of messages in the same number of queries at 3 and at 15", async () => {
    /*
     * The N+1 guard, and the property `374326e` established.
     *
     * Both room reads used to load every `chat_group_members` row before the
     * messages were even fetched, so the *rows* grew with the room. This asserts
     * the stronger and more durable version: the number of round trips does not
     * move at all. A future change that fetched a pseudonym per sender — the
     * obvious way to write this if you did not know better — would pass every
     * correctness test in `room-pseudonyms.itest.ts` and fail here.
     */
    // Three speakers in both. The rooms differ only in how many silent people
    // are sitting in them, which is exactly what must not cost anything.
    const small = await room(3, 3)
    const large = await room(15, 3)

    const small3 = await measure(() => readRoom(small.groupId, small.people[0].token))
    const large15 = await measure(() => readRoom(large.groupId, large.people[0].token))

    // The control for the comparison: both rooms must actually have returned
    // their messages, or this compares two identically broken requests.
    expect(small3.calls.length).toBeGreaterThan(0)
    expect(large15.calls.length).toBeGreaterThan(0)

    expect({
      atThree: small3.calls.length,
      atFifteen: large15.calls.length,
      hint:
        small3.calls.length === large15.calls.length
          ? ""
          : `Queries grew with room size: ${JSON.stringify(large15.calls)} vs ${JSON.stringify(small3.calls)}`,
    }).toEqual({ atThree: small3.calls.length, atFifteen: small3.calls.length, hint: "" })

    /*
     * And the rows, which is the half a call count cannot see. The page is the
     * same size in both rooms, so the members read for it must be too.
     */
    expect({
      membersAtThree: small3.rowsFrom("chat_group_members."),
      membersAtFifteen: large15.rowsFrom("chat_group_members."),
      hint: "",
    }).toEqual({
      membersAtThree: small3.rowsFrom("chat_group_members."),
      membersAtFifteen: small3.rowsFrom("chat_group_members."),
      hint: "",
    })
  })

  it("issues exactly one member lookup, whatever the room size", async () => {
    /*
     * Sharper than the count comparison, and it survives the absolute budget
     * changing for unrelated reasons. One page, one roster read.
     */
    const large = await room(12, 2)
    const { calls } = await measure(() => readRoom(large.groupId, large.people[0].token))

    const memberReads = calls.filter((c) => c.startsWith("chat_group_members."))
    expect({ memberReads, hint: "" }).toEqual({
      memberReads: ["chat_group_members.findMany"],
      hint: "",
    })
  })
})

describe("the feed's cost does not grow with the catalogue", () => {
  it("costs the same for 2 events and for 10", async () => {
    /*
     * `GET /events` fans out per page: favourites, check-ins, and the events
     * themselves. Those are three fixed round trips whatever the page holds —
     * the shape that must not become one lookup per card.
     */
    const viewerId = await makeUser(testId("qb_feed"))
    users.push(viewerId)
    const viewer = await db.user.findUniqueOrThrow({
      where: { id: viewerId },
      select: { email: true },
    })
    const token = signAccessToken(viewerId, viewer.email)

    const feed = (search: string) =>
      eventsRoute.GET(
        new NextRequest(`http://localhost/api/mobile/events?limit=50&search=${search}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ) as unknown as Promise<Response>

    const now = Date.now()
    const make = async (tag: string) => {
      const e = await db.events.create({
        data: {
          slug: testId("qbf"),
          title: `${tag} gathering`,
          description: `${tag} gathering`,
          start_time: new Date(now + HOUR),
          end_time: new Date(now + 3 * HOUR),
          timezone: "UTC",
          status: "published",
          visibility: "public",
          organizer_id: viewerId,
        },
      })
      events.push(e.id)
    }

    /*
     * Two independent terms, and this is not tidiness — it is the difference
     * between measuring the route and measuring a cache.
     *
     * The first draft grew one set of events and asked twice with the same
     * term. `GET /events` memoises on the filter inputs, so the second request
     * was answered from that cache and issued *fewer* queries than the first:
     * the assertion failed reporting that cost had "grown" when the second call
     * had barely reached the database at all. A cached comparison cannot detect
     * an N+1; it hides one.
     */
    const smallTag = `qbfa${Date.now().toString(36).replace(/\d/g, "")}z`
    const largeTag = `qbfb${Date.now().toString(36).replace(/\d/g, "")}z`

    for (let i = 0; i < 2; i++) await make(smallTag)
    for (let i = 0; i < 10; i++) await make(largeTag)

    const two = await measure(() => feed(smallTag))
    const ten = await measure(() => feed(largeTag))

    expect(two.calls.length).toBeGreaterThan(0)
    expect({
      atTwo: two.calls.length,
      atTen: ten.calls.length,
      hint:
        two.calls.length === ten.calls.length
          ? ""
          : `The feed's round trips grew with the number of events: ${JSON.stringify(ten.calls)}`,
    }).toEqual({ atTwo: two.calls.length, atTen: two.calls.length, hint: "" })
  })
})
