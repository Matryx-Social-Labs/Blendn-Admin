process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db } from "./helpers"
import { api, arrive, call, cleanupCrewWorld, liveEvent, person } from "./crew-world"
import { sqlCounter } from "./sql-count"

/* eslint-disable @typescript-eslint/no-require-imports */
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * The reply counts on a page of chat history (perf/chat-path). `_count.replies`
 * on the page's query made Prisma LEFT JOIN a `COUNT(*) GROUP BY parent_id`
 * over every message on the platform; the count is taken for the page's own
 * ids now. The numbers are unchanged: every child row counts, a deleted one
 * included, as `_count` always did.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

/**
 * The reply count is taken from the `parent_id` index for the page's ids: there
 * is such a statement, and every statement that counts by parent has the filter.
 */
function expectScopedReplyCount(sql: string[]) {
  const counting = sql.filter((q) => /COUNT\(\*\)/i.test(q) && /"parent_id"/.test(q))
  expect(counting.length).toBeGreaterThan(0)
  for (const q of counting) expect(q).toMatch(/"parent_id" IN \(/)
}

const MIN = 60_000
const T0 = Date.parse("2026-01-01T10:00:00Z")

async function world() {
  const host = await person("rc-host")
  const v = await person("rc-v")
  const a = await person("rc-a")
  const { eventId, occurrenceId } = await liveEvent(host.id)
  await arrive(eventId, occurrenceId, v)
  await arrive(eventId, occurrenceId, a)
  const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
  const say = (userId: string, minutes: number, extra: Record<string, unknown> = {}) =>
    db.chat_messages.create({ data: { chat_group_id: room.id, user_id: userId, content: `at ${minutes}`, created_at: new Date(T0 + minutes * MIN), ...extra } })
  const parent = await say(a.id, 1)
  const lonely = await say(a.id, 2)
  await say(v.id, 3, { parent_id: parent.id })
  await say(a.id, 4, { parent_id: parent.id })
  await say(a.id, 5, { parent_id: parent.id, deleted_at: new Date(T0 + 6 * MIN) }) // a deleted reply still counts
  return { v, eventId, roomId: room.id, parent: parent.id, lonely: lonely.id }
}

describe("reply counts on a page of history", () => {
  it("the room history route carries the same counts without scanning the platform", async () => {
    const w = await world()
    await api.read(w.v, w.roomId)
    const { result, sql } = await counter.during(() => api.read(w.v, w.roomId))
    expect(result.status).toBe(200)
    const byId = new Map<string, { _count: { replies: number } }>(result.body.data.messages.map((m: { id: string; _count: { replies: number } }) => [m.id, m]))
    expect({ parent: byId.get(w.parent)?._count, lonely: byId.get(w.lonely)?._count }).toEqual({ parent: { replies: 3 }, lonely: { replies: 0 } })
    expectScopedReplyCount(sql)
  })

  it("the event chat route carries the same counts without scanning the platform", async () => {
    const w = await world()
    const get = () => call(eventChat.GET, `/api/mobile/events/${w.eventId}/chat`, w.v, { params: { eventId: w.eventId } })
    await get()
    const { result, sql } = await counter.during(get)
    expect(result.status).toBe(200)
    const byId = new Map<string, { replyCount: number }>(result.body.data.messages.map((m: { id: string; replyCount: number }) => [m.id, m]))
    expect({ parent: byId.get(w.parent)?.replyCount, lonely: byId.get(w.lonely)?.replyCount }).toEqual({ parent: 3, lonely: 0 })
    expectScopedReplyCount(sql)
  })
})
