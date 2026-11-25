import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/push-notifications", () => ({ sendPushNotification: jest.fn(async () => true) }))
jest.mock("@/lib/socket-server", () => ({ ...jest.requireActual("@/lib/socket-server"), emitEventRsvpUpdate: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { emitEventRsvpUpdate } from "@/lib/socket-server"
import { feeScheduleFromMarket, type MarketFeeRow } from "@/lib/ticket-fees"

import { cleanup, closeDb, db, makeEvent, makeUser, onboard } from "./helpers"

/**
 * The going lifecycle, server side (SCRUM-1095, ROADMAP Going 2, 4 and 6).
 *
 * - A withdrawal once the doors are open is recorded (`not_going` + `cancelled_at`), never deleted, so a late
 *   "can't make it" is not read as a no-show; before the doors it is deleted as it always was.
 * - The going count goes out over the socket on every RSVP change.
 * - Going's rows carry `lobby.newCount`: posts by others since the caller's server-side seen marker, only while the
 *   Lobby is open, never the caller's own, never a hidden author's.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rsvp = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const meRsvps = require("@/app/api/mobile/me/rsvps/route") as typeof import("@/app/api/mobile/me/rsvps/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const seen = require("@/app/api/mobile/events/[eventId]/board/seen/route") as typeof import("@/app/api/mobile/events/[eventId]/board/seen/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  await db.board_seen.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

/** An event starting `startsIn` from now (doors are 90 minutes before it). */
async function eventStarting(startsIn: number) {
  const host = await makeUser("gl-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const start = new Date(Date.now() + startsIn)
  await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * HOUR) } })
  return eventId
}

const call = (handler: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response>, path: string, eventId: string, token: string, method: string, body?: unknown) =>
  handler(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ eventId }) }
  )

const rowOf = (eventId: string, userId: string) =>
  db.event_rsvps.findUnique({ where: { event_id_user_id: { event_id: eventId, user_id: userId } }, select: { status: true, cancelled_at: true } })

const going = (eventId: string, userId: string, status: "going" | "maybe" | "waitlisted" | "not_going" = "going") =>
  db.event_rsvps.create({ data: { event_id: eventId, user_id: userId, status } })

const myGoing = async (token: string) => {
  const res = await meRsvps.GET(new NextRequest("http://localhost/api/mobile/me/rsvps", { headers: { authorization: `Bearer ${token}` } }))
  expect(res.status).toBe(200)
  return (await res.json()).data.events as { id: string; lobby: { newCount: number } | null }[]
}

describe("withdrawing (DELETE /events/:id/rsvp)", () => {
  it("before the doors deletes the row, as it always did", async () => {
    const eventId = await eventStarting(48 * HOUR)
    const me = await person("gl-early")
    await going(eventId, me.id)

    const res = await call(rsvp.DELETE, "rsvp", eventId, me.token, "DELETE")

    expect(res.status).toBe(200)
    expect(await rowOf(eventId, me.id)).toBeNull()
  })

  it.each(["going", "maybe", "waitlisted"] as const)("once the doors are open records a %s as not_going with cancelled_at", async (status) => {
    const eventId = await eventStarting(30 * 60 * 1000) // doors an hour ago
    const me = await person(`gl-late-${status}`)
    await going(eventId, me.id, status)
    const before = Date.now()

    const res = await call(rsvp.DELETE, "rsvp", eventId, me.token, "DELETE")
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({ rsvpStatus: null, rsvpCount: 0 })
    const row = await rowOf(eventId, me.id)
    expect(row?.status).toBe("not_going")
    expect(row?.cancelled_at?.getTime()).toBeGreaterThanOrEqual(before - 1000)
    // Off the Going tab, like a deleted row.
    expect((await myGoing(me.token)).map((e) => e.id)).not.toContain(eventId)
  })

  it("after the doors writes nothing for somebody with no RSVP, still withdraws a plain not_going, and keeps a late cancel on a second DELETE", async () => {
    const eventId = await eventStarting(30 * 60 * 1000)
    const stranger = await person("gl-none")
    const said = await person("gl-said")
    const late = await person("gl-twice")
    await going(eventId, said.id, "not_going")
    await going(eventId, late.id)

    expect((await call(rsvp.DELETE, "rsvp", eventId, stranger.token, "DELETE")).status).toBe(200)
    expect((await call(rsvp.DELETE, "rsvp", eventId, said.token, "DELETE")).status).toBe(200)
    expect((await call(rsvp.DELETE, "rsvp", eventId, late.token, "DELETE")).status).toBe(200)
    const first = (await rowOf(eventId, late.id))?.cancelled_at
    expect((await call(rsvp.DELETE, "rsvp", eventId, late.token, "DELETE")).status).toBe(200)

    expect(await rowOf(eventId, stranger.id)).toBeNull()
    expect(await rowOf(eventId, said.id)).toBeNull()
    expect(first).toBeInstanceOf(Date)
    expect(await rowOf(eventId, late.id)).toEqual({ status: "not_going", cancelled_at: first })
  })

  it("POST not_going after the doors from going stamps cancelled_at, and going again clears it", async () => {
    const eventId = await eventStarting(30 * 60 * 1000)
    const me = await person("gl-post")
    await going(eventId, me.id)

    expect((await call(rsvp.POST, "rsvp", eventId, me.token, "POST", { status: "not_going" })).status).toBe(200)
    expect((await rowOf(eventId, me.id))?.cancelled_at).not.toBeNull()

    expect((await call(rsvp.POST, "rsvp", eventId, me.token, "POST", { status: "going" })).status).toBe(200)
    expect(await rowOf(eventId, me.id)).toEqual({ status: "going", cancelled_at: null })
  })

  it("is never a late cancel for somebody who came (checked in, then out): deleted, and a not_going POST gets no cancelled_at", async () => {
    const eventId = await eventStarting(30 * 60 * 1000)
    const came = await person("gl-came")
    const cameToo = await person("gl-came-post")
    const occurrence = await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId }, select: { id: true } })
    for (const p of [came, cameToo]) {
      await going(eventId, p.id)
      await db.event_check_ins.create({
        data: { event_id: eventId, occurrence_id: occurrence.id, user_id: p.id, status: "checked_out", check_in_time: new Date(Date.now() - 20 * 60 * 1000), check_out_time: new Date() },
      })
    }

    expect((await call(rsvp.DELETE, "rsvp", eventId, came.token, "DELETE")).status).toBe(200)
    expect((await call(rsvp.POST, "rsvp", eventId, cameToo.token, "POST", { status: "not_going" })).status).toBe(200)

    expect(await rowOf(eventId, came.id)).toBeNull()
    expect(await rowOf(eventId, cameToo.id)).toEqual({ status: "not_going", cancelled_at: null })
  })

  it("POST not_going before the doors is a plain not_going (no cancelled_at)", async () => {
    const eventId = await eventStarting(48 * HOUR)
    const me = await person("gl-post-early")
    await going(eventId, me.id)

    expect((await call(rsvp.POST, "rsvp", eventId, me.token, "POST", { status: "not_going" })).status).toBe(200)
    expect(await rowOf(eventId, me.id)).toEqual({ status: "not_going", cancelled_at: null })
  })
})

describe("the going count over the socket", () => {
  beforeEach(() => jest.mocked(emitEventRsvpUpdate).mockClear())

  it("goes out on an RSVP and on a withdrawal, with the count and no person", async () => {
    const eventId = await eventStarting(48 * HOUR)
    const me = await person("gl-sock")

    await call(rsvp.POST, "rsvp", eventId, me.token, "POST", { status: "going" })
    expect(emitEventRsvpUpdate).toHaveBeenLastCalledWith(eventId, 1)

    await call(rsvp.DELETE, "rsvp", eventId, me.token, "DELETE")
    expect(emitEventRsvpUpdate).toHaveBeenLastCalledWith(eventId, 0)
    expect(emitEventRsvpUpdate).toHaveBeenCalledTimes(2)
  })

  it("is not sent for a refused RSVP", async () => {
    const eventId = await eventStarting(48 * HOUR)
    await db.events.update({ where: { id: eventId }, data: { status: "cancelled" } })
    const me = await person("gl-sock-no")

    expect((await call(rsvp.POST, "rsvp", eventId, me.token, "POST", { status: "going" })).status).toBe(409)
    expect(emitEventRsvpUpdate).not.toHaveBeenCalled()
  })
})

describe("lobby.newCount on GET /me/rsvps", () => {
  const post = (eventId: string, authorId: string, at: Date, extra: { deleted?: boolean } = {}) =>
    db.board_posts.create({ data: { event_id: eventId, author_id: authorId, kind: "chat", body: "hi", created_at: at, deleted_at: extra.deleted ? new Date() : null } })

  it("counts others' live posts since the seen marker, moves only forward, and is null once the doors open", async () => {
    const open = await eventStarting(48 * HOUR)
    const doors = await eventStarting(30 * 60 * 1000)
    const me = await person("gl-lobby-me")
    const other = await person("gl-lobby-other")
    const blocked = await person("gl-lobby-blocked")
    await going(open, me.id)
    await going(doors, me.id)
    await db.blocked_users.create({ data: { blocker_id: me.id, blocked_id: blocked.id } })

    const t0 = new Date(Date.now() - 10 * 60 * 1000)
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60 * 1000)
    await post(open, other.id, at(1))
    await post(open, other.id, at(2))
    await post(open, me.id, at(3)) // mine: never news
    await post(open, blocked.id, at(4)) // hidden: never news
    await post(open, other.id, at(5), { deleted: true }) // gone: never news
    await post(doors, other.id, at(1))

    // Never opened: everything by others that the Lobby would show.
    let rows = await myGoing(me.token)
    expect(rows.find((e) => e.id === open)?.lobby).toEqual({ newCount: 2 })
    expect(rows.find((e) => e.id === doors)?.lobby).toBeNull()

    // Seen up to the first post: one left.
    expect((await call(seen.POST, "board/seen", open, me.token, "POST", { at: at(1).toISOString() })).status).toBe(200)
    rows = await myGoing(me.token)
    expect(rows.find((e) => e.id === open)?.lobby).toEqual({ newCount: 1 })

    // An older marker never moves it back.
    expect((await call(seen.POST, "board/seen", open, me.token, "POST", { at: t0.toISOString() })).status).toBe(200)
    expect((await db.board_seen.findUniqueOrThrow({ where: { user_id_event_id: { user_id: me.id, event_id: open } } })).seen_at).toEqual(at(1))

    // A marker in the future is clamped to now; with no body, now.
    expect((await call(seen.POST, "board/seen", open, me.token, "POST", { at: new Date(Date.now() + 24 * HOUR).toISOString() })).status).toBe(200)
    const marker = await db.board_seen.findUniqueOrThrow({ where: { user_id_event_id: { user_id: me.id, event_id: open } } })
    expect(marker.seen_at.getTime()).toBeLessThanOrEqual(Date.now())
    rows = await myGoing(me.token)
    expect(rows.find((e) => e.id === open)?.lobby).toEqual({ newCount: 0 })
  })

  it("clears a post stored to the microsecond once the marker is its createdAt as JSON gives it, to the millisecond (SCRUM-1118)", async () => {
    const eventId = await eventStarting(48 * HOUR)
    const me = await person("gl-us-me")
    const other = await person("gl-us-other")
    await going(eventId, me.id)
    // now() stores microseconds; Prisma and JSON carry milliseconds, so the client's `at` is the post's time truncated.
    const { id } = await db.board_posts.create({ data: { event_id: eventId, author_id: other.id, kind: "chat", body: "hi" } })
    await db.$executeRaw`UPDATE board_posts SET created_at = date_trunc('milliseconds', now()) - interval '1 minute' + interval '849 microseconds' WHERE id = ${id}::uuid`
    const shown = await db.board_posts.findUniqueOrThrow({ where: { id }, select: { created_at: true } })

    expect((await call(seen.POST, "board/seen", eventId, me.token, "POST", { at: shown.created_at.toISOString() })).status).toBe(200)

    const rows = await myGoing(me.token)
    expect(rows.find((e) => e.id === eventId)?.lobby).toEqual({ newCount: 0 })
    // A post a millisecond later is still news: truncation only forgives the part JSON cannot carry.
    await db.board_posts.create({ data: { event_id: eventId, author_id: other.id, kind: "chat", body: "again", created_at: new Date(shown.created_at.getTime() + 1) } })
    expect((await myGoing(me.token)).find((e) => e.id === eventId)?.lobby).toEqual({ newCount: 1 })
  })

  it("leaves out spare tickets where the Lobby hides them, and only there", async () => {
    const native = await eventStarting(48 * HOUR)
    const plain = await eventStarting(48 * HOUR)
    const me = await person("gl-tix-me")
    const other = await person("gl-tix-other")
    await going(native, me.id)
    await going(plain, me.id)
    const market = await db.markets.findUniqueOrThrow({ where: { code: "IN" } })
    await db.events.update({
      where: { id: native },
      data: { ticketing_mode: "native", ticketing_enabled_at: new Date(), ticket_fee_rule: "standard", ticket_fee_schedule: feeScheduleFromMarket(market as MarketFeeRow, new Date()) },
    })
    for (const eventId of [native, plain]) {
      await db.board_posts.create({ data: { event_id: eventId, author_id: other.id, kind: "seeking", sub_kind: "ticket", body: "Anyone got one?" } })
      await db.board_posts.create({ data: { event_id: eventId, author_id: other.id, kind: "chat", body: "See you there" } })
    }

    const before = process.env.TICKETING
    process.env.TICKETING = "true"
    try {
      const rows = await myGoing(me.token)
      expect(rows.find((e) => e.id === native)?.lobby).toEqual({ newCount: 1 })
      expect(rows.find((e) => e.id === plain)?.lobby).toEqual({ newCount: 2 })
    } finally {
      process.env.TICKETING = before
    }
  })

  it("refuses a marker from somebody the Lobby does not read for, and a bad time", async () => {
    const eventId = await eventStarting(48 * HOUR)
    const stranger = await person("gl-seen-stranger")
    const me = await person("gl-seen-bad")
    await going(eventId, me.id)

    expect((await call(seen.POST, "board/seen", eventId, stranger.token, "POST", {})).status).toBe(403)
    expect((await call(seen.POST, "board/seen", eventId, me.token, "POST", { at: "yesterday" })).status).toBe(400)
    expect(await db.board_seen.count({ where: { event_id: eventId } })).toBe(0)
  })
})
