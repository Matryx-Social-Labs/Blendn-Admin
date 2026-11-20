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

/*
 * "Met in the Lobby · Your ride" (Flow 5 C5 · B-A). A Lobby (board post) room hands out its own handles, which name
 * nobody outside it; a request sent by one is the one place outside the room that takes it back, and only while the
 * post's door seats both of them (`roomReadDenialFor`): the author or an accepted asker, the post standing, the room
 * not over. Then where they met is that room, read as the post's event and kind, never its ids or pseudonyms. A ride
 * is arranged before the night, so sharing the seated room is enough: no check-in is asked for.
 */
describe("Met in the Lobby: a request from a Lobby room's handle", () => {
  async function ride(title: string, author: Person, seated: Person[]) {
    const { eventId } = await room(title)
    const post = await db.board_posts.create({
      data: { event_id: eventId, author_id: author.id, kind: "offer", sub_kind: "ride", body: "Car from Indiranagar at 5:30", spaces_left: 3 },
      select: { id: true },
    })
    for (const p of seated) {
      await db.board_requests.create({
        data: { event_id: eventId, post_id: post.id, from_user_id: p.id, to_user_id: author.id, status: "accepted", decided_at: new Date() },
      })
    }
    const group = await db.chat_groups.create({
      data: { kind: "board_post", board_post_id: post.id, name: "Car from Indiranagar at 5:30", status: "active" },
      select: { id: true },
    })
    await db.chat_group_members.createMany({
      data: [author, ...seated].map((p, i) => ({ chat_group_id: group.id, user_id: p.id, anonymous_name: testId(`Lobby ${i}`).slice(0, 30) })),
    })
    const handle = (p: Person) => roomHandle({ kind: "board_post", groupId: group.id }, p.id)
    return { eventId, postId: post.id, roomId: group.id, handle }
  }

  it("says the Lobby, the night and the ride, to its author, and nothing that identifies the room", async () => {
    const [author, asker] = await Promise.all([person("ml-au"), person("ml-as")])
    const r = await ride("Rooftop Sundowner", author, [asker])

    const sent = await ask(asker, r.handle(author))
    expect(sent.status).toBe(201)
    expect(sent.body.data.request).not.toHaveProperty("metIn")
    const listed = await inbox(author)
    expect(listed.requests.find((x) => x.sender.id === asker.id)?.metIn).toEqual({
      kind: "board_post",
      name: "Rooftop Sundowner",
      subKind: "ride",
      yours: true,
    })
    for (const secret of [r.roomId, r.postId, r.eventId, r.handle(author), r.handle(asker), "Lobby 0", "Lobby 1"]) expect(listed.raw).not.toContain(secret)
    expect(await db.message_requests.findFirst({ where: { sender_id: asker.id }, select: { met_in_room_id: true, met_in_event_id: true } })).toEqual({
      met_in_room_id: r.roomId,
      met_in_event_id: null,
    })

    // To an asker it is somebody else's ride.
    const other = await person("ml-o")
    await db.board_requests.create({
      data: { event_id: r.eventId, post_id: r.postId, from_user_id: other.id, to_user_id: author.id, status: "accepted", decided_at: new Date() },
    })
    await db.chat_group_members.create({ data: { chat_group_id: r.roomId, user_id: other.id, anonymous_name: testId("Lobby 2").slice(0, 30) } })
    expect((await ask(other, r.handle(asker))).status).toBe(201)
    expect((await fromSender(asker, other))?.metIn).toMatchObject({ kind: "board_post", yours: false })
  })

  it("is refused, as nobody, when the post no longer seats either of them; the seated pair is the control", async () => {
    const [author, seated, withdrawn, outsider] = await Promise.all([person("ml-ra"), person("ml-rs"), person("ml-rw"), person("ml-ro")])
    const r = await ride("Refusals", author, [seated, withdrawn])
    await db.board_requests.updateMany({ where: { post_id: r.postId, from_user_id: withdrawn.id }, data: { status: "withdrawn" } })

    // Never in the room: a handle that travelled.
    expect((await ask(outsider, r.handle(author))).status).toBe(404)
    // Their ask withdrawn: still a member row, no longer seated, either way round.
    expect((await ask(withdrawn, r.handle(author))).status).toBe(404)
    expect((await ask(seated, r.handle(withdrawn))).status).toBe(404)
    expect(await db.message_requests.count({ where: { OR: [{ sender_id: { in: [outsider.id, withdrawn.id] } }, { recipient_id: withdrawn.id }] } })).toBe(0)

    expect((await ask(seated, r.handle(author))).status).toBe(201)
  })

  it("is refused once the room is over (its event's room closed), and a withdrawn post reads as no room", async () => {
    const [author, a, b] = await Promise.all([person("ml-oa"), person("ml-ob"), person("ml-oc")])
    const r = await ride("Over later", author, [a, b])
    expect((await ask(a, r.handle(author))).status).toBe(201)
    expect((await fromSender(author, a))?.metIn).toMatchObject({ kind: "board_post", name: "Over later" })

    await db.board_posts.update({ where: { id: r.postId }, data: { deleted_at: new Date() } })
    expect((await fromSender(author, a))?.metIn).toBeNull()
    expect((await ask(b, r.handle(author))).status).toBe(404)

    const late = await ride("Long over", author, [b])
    await db.events.update({ where: { id: late.eventId }, data: { start_time: new Date(Date.now() - 40 * 3_600_000), end_time: new Date(Date.now() - 30 * 3_600_000) } })
    expect((await ask(b, late.handle(author))).status).toBe(404)
  })

  it("goes with the sender's account, as an event room's does", async () => {
    const [author, a] = await Promise.all([person("ml-da"), person("ml-db")])
    const r = await ride("Erased ride", author, [a])
    expect((await ask(a, r.handle(author))).status).toBe(201)
    const erased = await account.DELETE(
      new NextRequest("http://localhost/api/mobile/account", { method: "DELETE", headers: { authorization: `Bearer ${a.token}` } })
    )
    expect(erased.status).toBe(200)
    expect(await db.message_requests.findMany({ where: { sender_id: a.id }, select: { met_in_room_id: true } })).toEqual([{ met_in_room_id: null }])
  })
})
