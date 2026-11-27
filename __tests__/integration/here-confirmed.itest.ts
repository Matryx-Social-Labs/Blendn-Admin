import { NextRequest } from "next/server"
import { Client } from "pg"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"

import { HERE_NOW, hereNow, hereNowFor } from "@/lib/attendee-counts"
import { inRoomWhere } from "@/lib/event-kind"
import { signAccessToken } from "@/lib/mobile-auth"
import { CONFIRMED_WINDOW_MINUTES } from "@/lib/presence"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/**
 * "Here" says how much of it is confirmed (SCRUM-1232). Pings are foreground
 * only, so `hereCount` is "arrived and not seen leaving": a phone that went home
 * in a pocket stays in it until the end + 60. `hereConfirmed` is the part of it
 * that was seen, or checked in, within `CONFIRMED_WINDOW_MINUTES` -- served next
 * to `hereCount`, which does not change, from the same one read.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
type Ctx = { params: Promise<Record<string, string>> }
type Handler = (req: NextRequest, ctx: Ctx) => Promise<Response>
const groups = require("@/app/api/mobile/chat/groups/route") as { GET: (req: NextRequest) => Promise<Response> }
const preview = require("@/app/api/mobile/events/[eventId]/room-preview/route") as { GET: Handler }
const detail = require("@/app/api/mobile/events/[eventId]/route") as { GET: Handler }
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.blocked_users.deleteMany({ where: { blocker_id: { in: users } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)
const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

/** Every statement sent to Postgres while `run` runs (as bell-cost.itest.ts counts them). */
async function statementsDuring<T>(run: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  const statements: string[] = []
  const original = Client.prototype.query
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string }
    statements.push(typeof first === "string" ? first : first.text ?? "")
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  } as typeof Client.prototype.query
  try {
    return { result: await run(), statements }
  } finally {
    Client.prototype.query = original
  }
}

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return id
}

async function room(label: string) {
  const host = await makeUser(testId(`${label}_host`), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const occurrenceId = await occurrenceOf(eventId)
  const chat = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
  /** In the room and the chat; `at` is the check-in, `lastSeen` the last ping that was written. */
  const seat = async (who: string, at: Date, lastSeen: Date, kind: "attendee" | "staff" = "attendee") => {
    await putInRoom({ eventId, occurrenceId, userId: who, at, lastSeen, kind })
    await db.chat_group_members.create({ data: { chat_group_id: chat.id, user_id: who, anonymous_name: testId("Otter"), status: "active" } })
  }
  return { eventId, roomId: chat.id, seat }
}

/** Both numbers on every surface a phone reads them from, and the Prisma predicate `hereCount` always was. */
async function everyCount(eventId: string, roomId: string, viewer: string) {
  const token = signAccessToken(viewer, `${viewer}@itest.invalid`)
  const params = { params: Promise.resolve({ eventId }) }
  const list = await (await groups.GET(new NextRequest("http://localhost/api/mobile/chat/groups", auth(token)))).json()
  const row = (list.data.groups as { id: string; hereCount: number; hereConfirmed: number }[]).find((g) => g.id === roomId)
  const p = (await (await preview.GET(new NextRequest(`http://localhost/api/mobile/events/${eventId}/room-preview`, auth(token)), params)).json()).data
  const d = (await (await detail.GET(new NextRequest(`http://localhost/api/mobile/events/${eventId}`, auth(token)), params)).json()).data.stats
  return {
    prismaHereCount: await db.event_check_ins.count({ where: { event_id: eventId, ...HERE_NOW, ...inRoomWhere() } }),
    helper: await hereNowFor(eventId),
    batched: (await hereNow([eventId])).get(eventId),
    row: { hereCount: row?.hereCount, hereConfirmed: row?.hereConfirmed },
    preview: { hereCount: p.hereCount, hereConfirmed: p.hereConfirmed },
    detail: { hereCount: d.hereCount, hereConfirmed: d.hereConfirmed },
  }
}

const both = (hereCount: number, hereConfirmed: number) => ({
  prismaHereCount: hereCount,
  helper: { hereCount, hereConfirmed },
  batched: { hereCount, hereConfirmed },
  row: { hereCount, hereConfirmed },
  preview: { hereCount, hereConfirmed },
  detail: { hereCount, hereConfirmed },
})

describe("hereConfirmed: the part of hereCount seen or checked in within the window", () => {
  let w: Awaited<ReturnType<typeof room>>
  let viewer: string, c: string

  beforeAll(async () => {
    w = await room("hc")
    // A: checked in 5 min ago. B: in for an hour, seen 10 min ago.
    // C: in for an hour, seen 45 min ago. D: as C, and suspended.
    const a = await person("hc_a")
    const b = await person("hc_b")
    c = await person("hc_c")
    const d = await person("hc_d")
    await w.seat(a, minutesAgo(5), minutesAgo(5))
    await w.seat(b, minutesAgo(60), minutesAgo(10))
    await w.seat(c, minutesAgo(60), minutesAgo(45))
    await w.seat(d, minutesAgo(60), minutesAgo(45))
    await db.user.update({ where: { id: d }, data: { suspended_at: new Date() } })
    viewer = a
  }, 60_000)

  it("the window is 30 minutes", () => {
    expect(CONFIRMED_WINDOW_MINUTES).toBe(30)
  })

  it("A, B, C here; A and B confirmed; D (suspended) in neither", async () => {
    expect(await everyCount(w.eventId, w.roomId, viewer)).toEqual(both(3, 2))
  })

  it("is one statement, the read that already counted hereCount", async () => {
    const { result, statements } = await statementsDuring(() => hereNowFor(w.eventId))
    expect(result).toEqual({ hereCount: 3, hereConfirmed: 2 })
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/FILTER/)
  })

  it("C pings: confirmed again, and hereCount does not move", async () => {
    // What the presence route writes on a ping it persists (lib/presence.ts shouldPersistPing).
    await db.event_check_ins.updateMany({ where: { event_id: w.eventId, user_id: c }, data: { last_seen_at: new Date() } })
    expect(await everyCount(w.eventId, w.roomId, viewer)).toEqual(both(3, 3))
  })
})

describe("hereConfirmed treats people exactly as hereCount does", () => {
  it("hidden and blocked-by-the-viewer people count in both; staff and the checked-out in neither; never above hereCount", async () => {
    const w = await room("hx")
    const viewer = await person("hx_viewer")
    const hidden = await person("hx_hidden")
    const blocked = await person("hx_blocked")
    const staff = await person("hx_staff")
    const left = await person("hx_left")
    const silent = await person("hx_silent")
    await w.seat(viewer, minutesAgo(5), minutesAgo(5))
    await w.seat(hidden, minutesAgo(5), minutesAgo(5))
    await w.seat(blocked, minutesAgo(5), minutesAgo(5))
    await w.seat(staff, minutesAgo(5), minutesAgo(5), "staff")
    await w.seat(left, minutesAgo(5), minutesAgo(5))
    await w.seat(silent, minutesAgo(120), minutesAgo(90))
    await db.profiles.update({ where: { id: hidden }, data: { show_online: false } })
    await db.blocked_users.create({ data: { blocker_id: viewer, blocked_id: blocked } })
    await db.event_check_ins.updateMany({
      where: { event_id: w.eventId, user_id: left },
      data: { status: "checked_out", check_out_time: new Date() },
    })

    // viewer, hidden, blocked inside and recent; silent inside, unconfirmed.
    const counts = await everyCount(w.eventId, w.roomId, viewer)
    expect(counts).toEqual(both(4, 3))
    expect(counts.helper.hereConfirmed).toBeLessThanOrEqual(counts.helper.hereCount)
  })

  it("a room nobody is in is 0 and 0, and an empty list is an empty map", async () => {
    const w = await room("hz")
    expect(await hereNowFor(w.eventId)).toEqual({ hereCount: 0, hereConfirmed: 0 })
    expect((await hereNow([])).size).toBe(0)
  })
})
