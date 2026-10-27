process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db } from "./helpers"
import { api, arrive, cleanupCrewWorld, crewOf, liveEvent, person, type Person } from "./crew-world"
import { sqlCounter, waveCounter } from "./sql-count"

/**
 * GET /api/mobile/chat/groups, byte for byte (perf/chat-path).
 *
 * The route was rebuilt for speed: fewer sequential levels, counts scoped to
 * the page's rooms, the last-message lookup per room rather than a scan of
 * every message. The snapshot below was taken from the route BEFORE that, over
 * a world with every case the response has a branch for, and it must not
 * change: same rows, same order, same previews, same unread counts.
 *
 * Random ids are replaced by their order of appearance, and the random titles and slugs and the clock-relative
 * times are dropped; nothing else is normalised.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

const MIN = 60_000
const T0 = Date.parse("2026-01-01T10:00:00Z")
const at = (minutes: number) => new Date(T0 + minutes * MIN)
const CLOCK_RELATIVE = new Set(["startTime", "endTime", "joinedAt", "closesAt", "title", "slug"])

function normalise(value: unknown, ids: Map<string, string>, mine: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => normalise(v, ids, mine))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !CLOCK_RELATIVE.has(k))
        .map(([k, v]) => [k, normalise(v, ids, mine)])
    )
  }
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    if (!ids.has(value)) ids.set(value, `id${ids.size + 1}`)
    return ids.get(value)
  }
  // A room handle for somebody else is a hash of random ids: only its presence is stable.
  if (typeof value === "string" && /^[A-Za-z0-9_-]{16,}$/.test(value) && !mine.has(value)) return "<handle>"
  return value
}

async function say(groupId: string, userId: string, minutes: number, extra: Record<string, unknown> = {}) {
  return db.chat_messages.create({
    data: { chat_group_id: groupId, user_id: userId, content: `line at ${minutes}`, created_at: at(minutes), ...extra },
  })
}

async function world() {
  const v = await person("cl-v", "Vee Viewer Rao")
  const host = await person("cl-host")
  const [a, b, c] = await Promise.all([person("cl-a"), person("cl-b"), person("cl-c")])
  await db.blocked_users.create({ data: { blocker_id: v.id, blocked_id: b.id } })

  const e1 = await liveEvent(host.id)
  for (const [p, name] of [[v, "Otter V"], [a, "Heron A"], [b, "Lynx B"], [c, "Wren C"]] as [Person, string][]) await arrive(e1.eventId, e1.occurrenceId, p, name)
  const r1 = await db.chat_groups.findUniqueOrThrow({ where: { event_id: e1.eventId }, select: { id: true } })
  const m1 = await say(r1.id, a.id, 1)
  await say(r1.id, b.id, 2) // blocked: counted nowhere, previewed nowhere
  const m3 = await say(r1.id, v.id, 3)
  await say(r1.id, c.id, 4, { deleted_at: at(5) }) // deleted: nowhere
  await say(r1.id, c.id, 6)
  await say(r1.id, a.id, 7, { type: "image", content: "https://img.invalid/x.jpg" })
  await say(r1.id, b.id, 8) // newest, but blocked: the room's own last_message_at still moves
  await db.chat_groups.update({ where: { id: r1.id }, data: { last_message_at: at(8) } })
  await db.chat_group_members.update({ where: { chat_group_id_user_id: { chat_group_id: r1.id, user_id: v.id } }, data: { last_read_message_id: m3.id } })
  expect(m1.id).toBeTruthy()

  // A room with nothing in it, and a muted, never-read one.
  const e2 = await liveEvent(host.id)
  await arrive(e2.eventId, e2.occurrenceId, v, "Otter V2")
  const r2 = await db.chat_groups.findUniqueOrThrow({ where: { event_id: e2.eventId }, select: { id: true } })
  await db.chat_groups.update({ where: { id: r2.id }, data: { last_message_at: at(-30) } })
  const e3 = await liveEvent(host.id)
  await arrive(e3.eventId, e3.occurrenceId, v, "Otter V3")
  await arrive(e3.eventId, e3.occurrenceId, a, "Heron A3")
  const r3 = await db.chat_groups.findUniqueOrThrow({ where: { event_id: e3.eventId }, select: { id: true } })
  await say(r3.id, a.id, 20)
  await say(r3.id, a.id, 21)
  await db.chat_groups.update({ where: { id: r3.id }, data: { last_message_at: at(21), status: "locked" } })
  await db.chat_group_members.update({
    where: { chat_group_id_user_id: { chat_group_id: r3.id, user_id: v.id } },
    data: { status: "muted", notification_preferences: { muted: true, muted_until: null } },
  })

  // Crews: one with talk (first names, an unread count), one silent.
  const talk = await crewOf(a, [v, c], "Saturday Lot")
  await say(talk.roomId, a.id, 30)
  await say(talk.roomId, c.id, 31)
  await say(talk.roomId, b.id, 32) // b is in no crew; a stray line from a blocked person
  await db.chat_groups.update({ where: { id: talk.roomId }, data: { last_message_at: at(32) } })
  const silent = await crewOf(c, [v], "Quiet Corner")
  void silent
  return { v, mine: new Set([v.id]) }
}

describe("the chat list's response", () => {
  it("is what the snapshot says, for a world with every branch in it", async () => {
    const { v, mine } = await world()
    await api.chatGroups(v) // warm
    const { result: res, sql } = await counter.during(() => api.chatGroups(v))
    // 43 statements before. The doors of the crew rooms are most of what is left.
    expect(sql.length).toBeLessThanOrEqual(24)
    expect(res.status).toBe(200)
    expect(res.body.data.groups).toHaveLength(3)
    expect(res.body.data.rooms).toHaveLength(2)
    expect(normalise(res.body.data, new Map(), mine)).toMatchSnapshot()
  })

  it("answers a person in no room at all with empty lists", async () => {
    const nobody = await person("cl-nobody")
    await api.chatGroups(nobody)
    const { result: res, sql } = await counter.during(() => api.chatGroups(nobody))
    // 37 before: the crew and Blend rooms' doors were asked of a person in none.
    expect(sql.length).toBeLessThanOrEqual(9)
    expect(sql.some((q) => /"public"\."(crews|blends|board_posts)"/.test(q))).toBe(false)
    expect(res.status).toBe(200)
    expect(res.body.data.groups).toEqual([])
    expect(res.body.data.rooms).toEqual([])
    expect(res.body.data.pagination).toMatchObject({ page: 1, totalCount: 0 })
  })

  it("waits on the database in few waves, not one read after another", async () => {
    const { v } = await world()
    const nobody = await person("cl-nobody-w")
    const lagged = waveCounter(40)
    try {
      const withCrews = await lagged.during(() => api.chatGroups(v))
      const none = await lagged.during(() => api.chatGroups(nobody))
      expect(withCrews.result.status).toBe(200)
      // Each Prisma operation held 40 ms, so a wave is a read that waited on another.
      // Before: the block list, count, page, crew rooms, read markers, last messages,
      // unread counts, check-ins and names, one after another (7+ with crews, 4 without).
      expect(withCrews.waves).toBeLessThanOrEqual(4)
      expect(none.waves).toBeLessThanOrEqual(2)
    } finally {
      await lagged.stop()
    }
  })
})
