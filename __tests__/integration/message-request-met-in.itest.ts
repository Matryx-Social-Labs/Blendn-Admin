import { NextRequest } from "next/server"

/*
 * Where two people met, on the request (Flow 5 · B-A, SCRUM-1042).
 *
 * Banter's Requests row reads "Met in the room at Rooftop Sundowner". The
 * request records the room it was sent from — the event of the handle the
 * sender used — and only when the two of them really shared that room, by the
 * rule `haveSharedAnEvent` keeps for any room (a venue day: windows that
 * overlapped). The recipient reads the room's display name and kind. Nothing
 * else: no pseudonym, no handle, no event id. A raw id, a handle from a room
 * the sender was never in, a room that is gone, and a block all read as no
 * room at all.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-met-in-secret-of-at-least-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { roomPseudonymOf } from "@/lib/anonymous-names"
import { blockPairIn } from "@/lib/block-pair"
import { signAccessToken } from "@/lib/mobile-auth"
import { roomHandle } from "@/lib/room-handle"
import { venueDayFor } from "@/lib/venue-day"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId, establish } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const account = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")

interface Person {
  id: string
  token: string
}
const users: string[] = []
const events: string[] = []
const venues: string[] = []

afterAll(async () => {
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await closeDb()
})

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await establish(id)
  await db.user.update({ where: { id }, data: { name: `Real ${label}`, image: `https://img.invalid/${label}.jpg` } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function room(title?: string): Promise<{ eventId: string; occurrence: string }> {
  const host = await makeUser(testId("mi-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  if (title) await db.events.update({ where: { id: eventId }, data: { title } })
  events.push(eventId)
  return { eventId, occurrence: await occurrenceOf(eventId) }
}

const ask = async (from: Person, recipientId: string) => {
  const res = await route.POST(
    new NextRequest("http://localhost/api/mobile/message-requests", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${from.token}` },
      body: JSON.stringify({ recipientId, message: "coffee after this?" }),
    })
  )
  return { status: res.status, body: await res.json() }
}

type Listed = { sender: { id: string }; metIn: unknown }
const inbox = async (of: Person, status = "pending") => {
  const res = await route.GET(
    new NextRequest(`http://localhost/api/mobile/message-requests?status=${status}`, {
      headers: { authorization: `Bearer ${of.token}` },
    })
  )
  const body = await res.json()
  return { status: res.status, raw: JSON.stringify(body), requests: (body.data?.requests ?? []) as Listed[] }
}
const fromSender = async (of: Person, sender: Person, status = "pending") =>
  (await inbox(of, status)).requests.find((r) => r.sender.id === sender.id)

describe("Met in: the room a request came from", () => {
  it("a request sent by a room's handle says that room, by name and kind, and nothing else about it", async () => {
    const { eventId, occurrence } = await room("Rooftop Sundowner")
    const [a, b] = await Promise.all([person("mi-a"), person("mi-b")])
    await putInRoom({ eventId, occurrenceId: occurrence, userId: a.id })
    await putInRoom({ eventId, occurrenceId: occurrence, userId: b.id })
    const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })
    await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: a.id, anonymous_name: testId("Lunar Fox"), status: "active" } })

    const handle = roomHandle(eventId, b.id)
    const sent = await ask(a, handle)
    expect(sent.status).toBe(201)
    // The sender is not told anything new by asking.
    expect(sent.body.data.request).not.toHaveProperty("metIn")

    const listed = await inbox(b)
    const row = listed.requests.find((r) => r.sender.id === a.id)
    expect(row?.metIn).toEqual({ kind: "event", name: "Rooftop Sundowner" })

    // Anonymity: neither the room's ids nor who the sender was in it.
    const pseudonym = await roomPseudonymOf(eventId, a.id)
    expect(pseudonym).toMatch(/Lunar Fox/)
    expect(listed.raw).not.toContain(pseudonym)
    expect(listed.raw).not.toContain(eventId)
    expect(listed.raw).not.toContain(handle)
    expect(listed.raw).not.toContain(roomHandle(eventId, a.id))
    expect(await db.message_requests.findFirst({ where: { sender_id: a.id, recipient_id: b.id }, select: { met_in_event_id: true } })).toEqual({
      met_in_event_id: eventId,
    })
  })

  it("a request by raw id has no room (control: the same pair by handle has one)", async () => {
    const { eventId, occurrence } = await room()
    const [a, b, c] = await Promise.all([person("mi-ra"), person("mi-rb"), person("mi-rc")])
    for (const p of [a, b, c]) await putInRoom({ eventId, occurrenceId: occurrence, userId: p.id })

    expect((await ask(a, b.id)).status).toBe(201)
    expect((await fromSender(b, a))?.metIn).toBeNull()

    expect((await ask(c, roomHandle(eventId, b.id))).status).toBe(201)
    expect((await fromSender(b, c))?.metIn).not.toBeNull()
  })

  it("a handle from a room the sender was never in is not where they met, though the request goes", async () => {
    const met = await room()
    const elsewhere = await room("A room the sender never entered")
    const [a, b] = await Promise.all([person("mi-ea"), person("mi-eb")])
    // They shared `met` (so the request is allowed); only b was in `elsewhere`.
    await putInRoom({ eventId: met.eventId, occurrenceId: met.occurrence, userId: a.id, at: new Date(Date.now() - 50 * 60_000) })
    await putInRoom({ eventId: met.eventId, occurrenceId: met.occurrence, userId: b.id, at: new Date(Date.now() - 50 * 60_000) })
    await putInRoom({ eventId: elsewhere.eventId, occurrenceId: elsewhere.occurrence, userId: b.id })

    expect((await ask(a, roomHandle(elsewhere.eventId, b.id))).status).toBe(201)
    const row = await fromSender(b, a)
    expect(row).toBeDefined()
    expect(row?.metIn).toBeNull()
  })

  it("a venue day says the venue's name, never the stored 'Venue day · …' title; windows that never overlapped say nothing", async () => {
    const v = await db.venues.create({
      data: { name: testId("Third Wave"), city: "Bengaluru", latitude: 12.97, longitude: 77.59, timezone: "Asia/Kolkata", day_reset_hour: 6 },
    })
    venues.push(v.id)
    const day = await venueDayFor(v.id)
    if (!day) throw new Error("no venue day")
    events.push(day.id)
    const occurrence = await occurrenceOf(day.id)
    const [a, b, late] = await Promise.all([person("mi-va"), person("mi-vb"), person("mi-vl")])
    const t = Date.now()
    await putInRoom({ eventId: day.id, occurrenceId: occurrence, userId: a.id, at: new Date(t - 40 * 60_000) })
    await putInRoom({ eventId: day.id, occurrenceId: occurrence, userId: b.id, at: new Date(t - 30 * 60_000) })
    // `late` arrived after a had left: the same day, never the same room.
    await db.presence_sessions.updateMany({ where: { user_id: a.id, event_id: day.id }, data: { departed_at: new Date(t - 20 * 60_000) } })
    await db.event_check_ins.updateMany({ where: { user_id: a.id, event_id: day.id }, data: { status: "checked_out", check_out_time: new Date(t - 20 * 60_000) } })
    await putInRoom({ eventId: day.id, occurrenceId: occurrence, userId: late.id, at: new Date(t - 10 * 60_000) })

    expect((await ask(a, roomHandle(day.id, b.id))).status).toBe(201)
    const listed = await inbox(b)
    expect(listed.requests.find((r) => r.sender.id === a.id)?.metIn).toEqual({ kind: "venue_day", name: v.name })
    expect(listed.raw).not.toContain("Venue day")

    // Never met: the request is refused outright (no shared room, answered as nobody: SCRUM-1050), so nothing claims one.
    const refused = await ask(late, roomHandle(day.id, a.id))
    expect(refused.status).toBe(404)
    expect(await db.message_requests.count({ where: { sender_id: late.id } })).toBe(0)
  })

  it("a room that is gone, or hidden, reads as no room", async () => {
    const gone = await room("Deleted later")
    const hidden = await room("Suspended later")
    const [a, b, c] = await Promise.all([person("mi-ga"), person("mi-gb"), person("mi-gc")])
    await putInRoom({ eventId: gone.eventId, occurrenceId: gone.occurrence, userId: a.id, at: new Date(Date.now() - 50 * 60_000) })
    await putInRoom({ eventId: gone.eventId, occurrenceId: gone.occurrence, userId: b.id, at: new Date(Date.now() - 50 * 60_000) })
    await putInRoom({ eventId: hidden.eventId, occurrenceId: hidden.occurrence, userId: c.id })
    await putInRoom({ eventId: hidden.eventId, occurrenceId: hidden.occurrence, userId: b.id })

    expect((await ask(a, roomHandle(gone.eventId, b.id))).status).toBe(201)
    expect((await ask(c, roomHandle(hidden.eventId, b.id))).status).toBe(201)
    // Control: both say their room while it stands.
    expect((await fromSender(b, a))?.metIn).toEqual({ kind: "event", name: "Deleted later" })
    expect((await fromSender(b, c))?.metIn).toEqual({ kind: "event", name: "Suspended later" })

    await db.events.update({ where: { id: gone.eventId }, data: { deleted_at: new Date() } })
    await db.events.update({ where: { id: hidden.eventId }, data: { status: "draft" } })
    expect((await fromSender(b, a))?.metIn).toBeNull()
    expect((await fromSender(b, c))?.metIn).toBeNull()
    // A hard delete keeps the request and drops its room (ON DELETE SET NULL).
    await db.presence_sessions.deleteMany({ where: { event_id: gone.eventId } })
    await db.event_check_ins.deleteMany({ where: { event_id: gone.eventId } })
    await db.events.delete({ where: { id: gone.eventId } })
    expect(await db.message_requests.findMany({ where: { sender_id: a.id, recipient_id: b.id }, select: { met_in_event_id: true } })).toEqual([
      { met_in_event_id: null },
    ])
    expect((await fromSender(b, a))?.metIn).toBeNull()
  })

  it("after a block the request is not in the inbox, room and all", async () => {
    const { eventId, occurrence } = await room("Blocked here")
    const [a, b] = await Promise.all([person("mi-ba"), person("mi-bb")])
    await putInRoom({ eventId, occurrenceId: occurrence, userId: a.id })
    await putInRoom({ eventId, occurrenceId: occurrence, userId: b.id })
    expect((await ask(a, roomHandle(eventId, b.id))).status).toBe(201)
    // Control: listed with its room before the block.
    expect((await fromSender(b, a))?.metIn).toEqual({ kind: "event", name: "Blocked here" })

    await db.$transaction((tx) => blockPairIn(tx, b.id, a.id))
    expect(await fromSender(b, a)).toBeUndefined()
    expect((await inbox(b)).raw).not.toContain("Blocked here")
  })

  it("a sender who deletes their account takes where they met with them; the request row stays, as its words go", async () => {
    const { eventId, occurrence } = await room("Erased later")
    const [a, b, c] = await Promise.all([person("mi-da"), person("mi-db"), person("mi-dc")])
    for (const p of [a, b, c]) await putInRoom({ eventId, occurrenceId: occurrence, userId: p.id })
    expect((await ask(a, roomHandle(eventId, b.id))).status).toBe(201)
    expect((await ask(c, roomHandle(eventId, b.id))).status).toBe(201)

    const erased = await account.DELETE(
      new NextRequest("http://localhost/api/mobile/account", { method: "DELETE", headers: { authorization: `Bearer ${a.token}` } })
    )
    expect(erased.status).toBe(200)
    expect(await db.message_requests.findMany({ where: { sender_id: a.id }, select: { message: true, met_in_event_id: true } })).toEqual([
      { message: null, met_in_event_id: null },
    ])
    expect((await fromSender(b, a))?.metIn ?? null).toBeNull()
    // Control: another sender's request from the same room keeps its room.
    expect((await fromSender(b, c))?.metIn).toEqual({ kind: "event", name: "Erased later" })
  })
})
