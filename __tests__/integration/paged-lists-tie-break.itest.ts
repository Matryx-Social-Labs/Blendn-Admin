process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { randomUUID } from "crypto"

import { db, putInRoom, testId } from "./helpers"
import { arrive, call, cleanupCrewWorld, liveEvent, person, routes, world, type Person } from "./crew-world"

/**
 * Every offset-paged mobile list ends its order with a unique key (SCRUM-1356).
 *
 * Postgres promises no order among rows that tie on the ORDER BY, and two
 * queries with different OFFSET/LIMIT are free to break the tie differently (a
 * top-N heapsort keeps a different heap for LIMIT 10 than for LIMIT 20). So 25
 * events at one start time, paged by 10, could repeat one on page 2 and never
 * show another; the app hides the repeat, and the lost event is simply not in
 * the scroll. The same for rooms with no messages (all NULL `last_message_at`)
 * and every other paged list below, each built here as 25 rows that tie on the
 * route's sort.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const r = {
  events: require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route"),
  search: require("@/app/api/mobile/events/search/route") as typeof import("@/app/api/mobile/events/search/route"),
  eventChat: require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route"),
  requests: require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route"),
}
/* eslint-enable @typescript-eslint/no-require-imports */

afterAll(async () => {
  await db.message_requests.deleteMany({ where: { recipient_id: { in: world.users } } })
  await cleanupCrewWorld()
})

const N = 25
const PAGE = 10
const PAGES = Math.ceil(N / PAGE) // 3: the last one short
const WORD = `tiebreak${randomUUID().replace(/-/g, "").slice(0, 10)}`
const CITY = `Tiecity${randomUUID().replace(/-/g, "").slice(0, 8)}`
/** One start time for all 25, on the minute, two days out: 19:00 is everybody's. */
const START = new Date(Math.ceil((Date.now() + 2 * 86_400_000) / 60_000) * 60_000)
const AT = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000)

let viewer: Person
let others: string[]
const eventIds: string[] = []
let roomId: string
let liveEventId: string

beforeAll(async () => {
  viewer = await person("tb-viewer")
  const host = await person("tb-host")

  // 25 same-time public events in one city, one place, one title word.
  for (let i = 0; i < N; i++) eventIds.push(randomUUID())
  await db.events.createMany({
    data: eventIds.map((id) => ({
      id,
      slug: testId("tb-evt"),
      title: `${WORD} night`,
      description: "tie-break fixture",
      start_time: START,
      end_time: new Date(START.getTime() + 3 * 3_600_000),
      timezone: "UTC",
      status: "published" as const,
      visibility: "public" as const,
      organizer_id: host.id,
      city: CITY,
      latitude: 12.9716,
      longitude: 77.5946,
    })),
  })
  world.events.push(...eventIds)

  // Each of those events' rooms, the viewer a member of all 25, none with a message.
  await db.chat_groups.createMany({ data: eventIds.map((event_id) => ({ event_id, name: "room" })) })
  const rooms = await db.chat_groups.findMany({ where: { event_id: { in: eventIds } }, select: { id: true } })
  await db.chat_group_members.createMany({
    data: rooms.map((g) => ({ chat_group_id: g.id, user_id: viewer.id, anonymous_name: "Otter V", joined_at: AT })),
  })

  // One live room: the viewer and 25 people in it, arrived at one instant, joined at one instant.
  const live = await liveEvent(host.id)
  liveEventId = live.eventId
  await arrive(live.eventId, live.occurrenceId, viewer, "Otter V")
  roomId = (await db.chat_groups.findUniqueOrThrow({ where: { event_id: live.eventId }, select: { id: true } })).id
  others = Array.from({ length: N }, () => testId("tb-guest"))
  await db.user.createMany({ data: others.map((id) => ({ id, email: `${id}@itest.invalid`, name: "Guest" })) })
  world.users.push(...others)
  for (const userId of others) await putInRoom({ eventId: live.eventId, occurrenceId: live.occurrenceId, userId, at: AT })
  await db.chat_group_members.createMany({
    data: others.map((user_id, i) => ({ chat_group_id: roomId, user_id, anonymous_name: `Heron ${i}`, joined_at: AT })),
  })
  // 25 lines at one instant, and 25 message requests to the viewer at one instant.
  await db.chat_messages.createMany({
    data: others.map((user_id) => ({ chat_group_id: roomId, user_id, content: "same moment", created_at: AT })),
  })
  await db.message_requests.createMany({
    data: others.map((sender_id) => ({ sender_id, recipient_id: viewer.id, created_at: AT, updated_at: AT })),
  })
}, 120_000)

/** Pages 1..PAGES of a list, every id in the order served. */
async function paged(read: (page: number) => Promise<string[]>) {
  const seen: string[] = []
  for (let page = 1; page <= PAGES; page++) seen.push(...(await read(page)))
  return seen
}

async function get(handler: unknown, path: string, params: Record<string, string> = {}) {
  const res = await call(handler, path, viewer, { params })
  expect(res.status).toBe(200)
  return res.body.data
}

/** Exactly the expected ids, each once. */
function expectEach(seen: string[], expected: string[]) {
  expect(seen).toHaveLength(new Set(seen).size)
  expect([...seen].sort()).toEqual([...expected].sort())
}

describe("offset-paged mobile lists never repeat or skip a row that ties on the sort", () => {
  it("GET /events (the Pulse date page): 25 events at one start time", async () => {
    const seen = await paged(async (page) =>
      (await get(r.events.GET, `/api/mobile/events?city=${CITY}&limit=${PAGE}&page=${page}`)).events.map((e: { id: string }) => e.id)
    )
    expectEach(seen, eventIds)
  })

  it("GET /events?sortBy=distance: 25 events at one place and one time", async () => {
    const seen = await paged(async (page) =>
      (
        await get(r.events.GET, `/api/mobile/events?city=${CITY}&sortBy=distance&lat=12.9716&lon=77.5946&limit=${PAGE}&page=${page}`)
      ).events.map((e: { id: string }) => e.id)
    )
    expectEach(seen, eventIds)
  })

  it("GET /events/search: 25 events of one rank and one start time", async () => {
    const seen = await paged(async (page) =>
      (await get(r.search.GET, `/api/mobile/events/search?q=${WORD}&limit=${PAGE}&page=${page}`)).events.map((e: { id: string }) => e.id)
    )
    expectEach(seen, eventIds)
  })

  it("GET /chat/groups: 25 rooms with no message, all NULL last_message_at", async () => {
    const seen = await paged(async (page) =>
      (await get(routes.chatGroups.GET, `/api/mobile/chat/groups?limit=${PAGE}&page=${page}`)).groups
        .map((g: { event: { id: string } }) => g.event.id)
        .filter((id: string) => id !== liveEventId)
    )
    expectEach(seen, eventIds)
  })

  // The lists below hold the viewer too, or name people by room handle: the
  // check is 26 (or 25) distinct entries, each once, against one large page.
  async function wholeAndPaged(read: (limit: number, page: number) => Promise<string[]>, expected: number) {
    const whole = await read(100, 1)
    expect(whole).toHaveLength(expected)
    const seen: string[] = []
    for (let page = 1; page <= Math.ceil(expected / PAGE); page++) seen.push(...(await read(PAGE, page)))
    expectEach(seen, whole)
  }

  it("GET /chat/groups/:id/participants: 25 people who joined at one instant", async () => {
    await wholeAndPaged(
      async (limit, page) =>
        (
          await get(routes.participants.GET, `/api/mobile/chat/groups/${roomId}/participants?limit=${limit}&offset=${(page - 1) * limit}`, {
            chatGroupId: roomId,
          })
        ).participants.map((p: { userId: string }) => p.userId),
      N + 1
    )
  })

  it("GET /events/:id/checkins: 25 people checked in at one instant", async () => {
    await wholeAndPaged(
      async (limit, page) =>
        (
          await get(routes.checkins.GET, `/api/mobile/events/${liveEventId}/checkins?limit=${limit}&page=${page}`, { eventId: liveEventId })
        ).attendees.map((a: { userId: string }) => a.userId),
      N + 1
    )
  })

  it("GET /events/:id/chat: 25 lines sent at one instant", async () => {
    await wholeAndPaged(
      async (limit, page) =>
        (await get(r.eventChat.GET, `/api/mobile/events/${liveEventId}/chat?limit=${limit}&page=${page}`, { eventId: liveEventId })).messages.map(
          (m: { id: string }) => m.id
        ),
      N
    )
  })

  it("GET /message-requests: 25 requests received at one instant", async () => {
    await wholeAndPaged(
      async (limit, page) =>
        (await get(r.requests.GET, `/api/mobile/message-requests?limit=${limit}&offset=${(page - 1) * limit}`)).requests.map(
          (q: { id: string }) => q.id
        ),
      N
    )
  })
})
