process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db as appDb } from "@/lib/db"
import { db } from "./helpers"
import { api, arrive, cleanupCrewWorld, liveEvent, person } from "./crew-world"

/**
 * A room's `unreadCount` on the chat list stops at 10 (SCRUM-1223). The app never says more than "9+", and the count
 * ran over every visible message of every room the viewer is in, on every 30 s poll of every checked-in phone. Capped,
 * a room costs at most ten index probes however long its history; a room with a read marker is counted only from it.
 */
afterAll(cleanupCrewWorld)

const MIN = 60_000
const T0 = Date.parse("2026-01-01T10:00:00Z")
const at = (minutes: number) => new Date(T0 + minutes * MIN)

async function roomWith(label: string) {
  const host = await person(`${label}-host`)
  const viewer = await person(`${label}-v`)
  const a = await person(`${label}-a`)
  const e = await liveEvent(host.id)
  await arrive(e.eventId, e.occurrenceId, viewer, "Otter V")
  await arrive(e.eventId, e.occurrenceId, a, "Heron A")
  const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: e.eventId }, select: { id: true } })
  return { viewer, a, roomId: room.id }
}

async function say(roomId: string, userId: string, n: number, from = 1) {
  await db.chat_messages.createMany({
    data: Array.from({ length: n }, (_, i) => ({ chat_group_id: roomId, user_id: userId, content: `line ${from + i}`, created_at: at(from + i) })),
  })
}

async function readUpTo(roomId: string, viewerId: string, minute: number) {
  const marker = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: roomId, created_at: at(minute) }, select: { id: true } })
  await db.chat_group_members.updateMany({ where: { chat_group_id: roomId, user_id: viewerId }, data: { last_read_message_id: marker.id } })
}

describe("the chat list's unread count is capped per room", () => {
  it("says 10 for a room with 25 unread and no read marker (the old count said 25)", async () => {
    const { viewer, a, roomId } = await roomWith("uc-25")
    await say(roomId, a.id, 25)

    const res = await api.chatGroups(viewer)

    expect(res.status).toBe(200)
    expect(res.body.data.groups[0].unreadCount).toBe(10)
    expect(await db.chat_messages.count({ where: { chat_group_id: roomId, deleted_at: null } })).toBe(25)
  })

  it("says 10 for a room with 25 newer than the read marker", async () => {
    const { viewer, a, roomId } = await roomWith("uc-m25")
    await say(roomId, a.id, 26)
    await readUpTo(roomId, viewer.id, 1)

    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].unreadCount).toBe(10)
  })

  it("says 3 for a room with a read marker and 3 newer", async () => {
    const { viewer, a, roomId } = await roomWith("uc-m3")
    await say(roomId, a.id, 8)
    await readUpTo(roomId, viewer.id, 5)

    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].unreadCount).toBe(3)
  })

  it("says 4 for a room with no read marker and 4 messages", async () => {
    const { viewer, a, roomId } = await roomWith("uc-4")
    await say(roomId, a.id, 4)

    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].unreadCount).toBe(4)
  })

  it("still leaves the viewer's own lines out under the cap", async () => {
    const { viewer, a, roomId } = await roomWith("uc-own")
    await say(roomId, viewer.id, 20)
    await say(roomId, a.id, 2, 21)

    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].unreadCount).toBe(2)
  })

  it("counts only lines that can be unread before it stops: deleted lines and adverts do not fill the cap", async () => {
    const { viewer, a, roomId } = await roomWith("uc-filt")
    await say(roomId, a.id, 1)
    await readUpTo(roomId, viewer.id, 1)
    await db.chat_messages.createMany({
      data: Array.from({ length: 12 }, (_, i) => [
        { chat_group_id: roomId, user_id: a.id, content: `gone ${i}`, deleted_at: at(30), created_at: at(2 + i) },
        { chat_group_id: roomId, user_id: a.id, content: `advert ${i}`, metadata: { sponsored_message_id: "44444444-4444-4444-8444-444444444444" }, created_at: at(2 + i) },
      ]).flat(),
    })
    await say(roomId, a.id, 3, 20)

    const marked = await api.chatGroups(viewer)
    await db.chat_group_members.updateMany({ where: { chat_group_id: roomId, user_id: viewer.id }, data: { last_read_message_id: null } })
    const unmarked = await api.chatGroups(viewer)

    expect(marked.body.data.groups[0].unreadCount).toBe(3)
    expect(unmarked.body.data.groups[0].unreadCount).toBe(4)
  })

  it("counts a room whose read marker's message is gone from its start, capped, beside a room with a live marker", async () => {
    const live = await roomWith("uc-live")
    await say(live.roomId, live.a.id, 8)
    await readUpTo(live.roomId, live.viewer.id, 5)
    const host = await person("uc-gone-host")
    const e = await liveEvent(host.id)
    await arrive(e.eventId, e.occurrenceId, live.viewer, "Otter V3")
    await arrive(e.eventId, e.occurrenceId, live.a, "Heron A3")
    const gone = await db.chat_groups.findUniqueOrThrow({ where: { event_id: e.eventId }, select: { id: true } })
    await say(gone.id, live.a.id, 15)
    await db.chat_group_members.updateMany({
      where: { chat_group_id: gone.id, user_id: live.viewer.id },
      data: { last_read_message_id: "55555555-5555-4555-8555-555555555555" },
    })

    const res = await api.chatGroups(live.viewer)

    const unread = new Map((res.body.data.groups as { id: string; unreadCount: number }[]).map((g) => [g.id, g.unreadCount]))
    expect(unread.get(live.roomId)).toBe(3)
    expect(unread.get(gone.id)).toBe(10)
  })

  it("says 0 once the room is read through the API, and the marker is the newest line", async () => {
    const { viewer, a, roomId } = await roomWith("uc-read")
    await say(roomId, a.id, 25)

    await api.read(viewer, roomId)
    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].unreadCount).toBe(0)
    const newest = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: roomId }, orderBy: { created_at: "desc" }, select: { id: true } })
    const member = await db.chat_group_members.findFirstOrThrow({ where: { chat_group_id: roomId, user_id: viewer.id }, select: { last_read_message_id: true } })
    expect(member.last_read_message_id).toBe(newest.id)
  })
})

describe("the totals query", () => {
  /** Every `$queryRaw` the list ran, as its SQL text and the values bound to it (arrays flattened). */
  async function rawStatementsOf(run: () => Promise<unknown>) {
    void appDb.$connect // lib/db makes its client on first touch; the spy goes on that client
    const client = globalThis.prisma!
    const spy = jest.spyOn(client, "$queryRaw")
    try {
      await run()
      return spy.mock.calls.map(([strings, ...values]) => ({
        sql: Array.isArray(strings) ? (strings as readonly string[]).join("?") : String(strings),
        values: values.flatMap((v) => (Array.isArray(v) ? v : [v])),
      }))
    } finally {
      spy.mockRestore()
    }
  }

  it("leaves out a room with a read marker: it is counted from its marker only", async () => {
    const marked = await roomWith("uc-sq-m")
    await say(marked.roomId, marked.a.id, 6)
    await readUpTo(marked.roomId, marked.viewer.id, 3)
    // The same viewer, in a second room they have read nothing of.
    const host = await person("uc-sq-host")
    const e = await liveEvent(host.id)
    await arrive(e.eventId, e.occurrenceId, marked.viewer, "Otter V2")
    await arrive(e.eventId, e.occurrenceId, marked.a, "Heron A2")
    const unmarked = await db.chat_groups.findUniqueOrThrow({ where: { event_id: e.eventId }, select: { id: true } })
    await say(unmarked.id, marked.a.id, 2)

    const statements = await rawStatementsOf(() => api.chatGroups(marked.viewer))

    const totals = statements.filter((s) => /chat_messages/.test(s.sql) && /count\(/i.test(s.sql) && s.values.includes(unmarked.id))
    expect(totals).toHaveLength(1)
    expect(totals[0].values).not.toContain(marked.roomId)
  })
})
