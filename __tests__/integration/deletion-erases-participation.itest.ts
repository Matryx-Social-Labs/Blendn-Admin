import { NextRequest } from "next/server"

/*
 * Two things account deletion left behind, driven on staging (SCRUM-132):
 *
 * 1. The `going` RSVPs on events still to come — the organiser's overview read
 *    "1 going · 1 day to go" for a person who no longer existed.
 * 2. The access token that made the deletion, still valid for up to fifteen
 *    minutes, could `PUT /profiles/:id { name: "Ghost" }` onto the erased
 *    profile and RSVP for it.
 *
 * Real route, real token, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { signAccessToken } from "@/lib/mobile-auth"
import { getOccupancy } from "@/lib/occupancy"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as
  typeof import("@/app/api/mobile/profiles/[userId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rsvpRoute = require("@/app/api/mobile/events/[eventId]/rsvp/route") as
  typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

const req = (method: string, url: string, token: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

it("releases open RSVPs, keeps attendance, and refuses the token that did it", async () => {
  const host = await makeUser("dep-host", "organizer")
  users.push(host)
  const past = await makeEvent(host) // starts an hour ago
  events.push(past)
  const future = await makeEvent(host)
  events.push(future)
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await db.events.update({
    where: { id: future },
    data: { start_time: start, end_time: new Date(start.getTime() + 3 * 60 * 60 * 1000), max_capacity: 1 },
  })

  const id = await makeUser("dep-leaver")
  users.push(id)
  await db.profiles.create({ data: { id, name: "Leaver", date_of_birth: new Date("1996-05-12") } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  const token = signAccessToken(id, email)

  // Going to both; somebody is waiting for the single seat on the future one.
  await db.event_rsvps.createMany({
    data: [
      { event_id: past, user_id: id, status: "going" },
      { event_id: future, user_id: id, status: "going" },
    ],
  })
  const waiter = await makeUser("dep-waiter")
  users.push(waiter)
  await db.event_rsvps.create({ data: { event_id: future, user_id: waiter, status: "waitlisted" } })

  const res = await accountRoute.DELETE(req("DELETE", "/api/mobile/account", token))
  expect(res.status).toBe(200)

  // The seat on the future event is released and handed on; the past row stays.
  expect(await db.event_rsvps.findMany({ where: { user_id: id }, select: { event_id: true } })).toEqual([
    { event_id: past },
  ])
  expect(
    (await db.event_rsvps.findUniqueOrThrow({ where: { event_id_user_id: { event_id: future, user_id: waiter } } })).status
  ).toBe("going")

  // The same token, a moment later: refused, so nothing can be written back.
  const put = await profileRoute.PUT(
    req("PUT", `/api/mobile/profiles/${id}`, token, { name: "Ghost" }),
    { params: Promise.resolve({ userId: id }) }
  )
  expect(put.status).toBe(401)
  const rsvp = await rsvpRoute.POST(
    req("POST", `/api/mobile/events/${future}/rsvp`, token, { status: "going" }),
    { params: Promise.resolve({ eventId: future }) }
  )
  expect(rsvp.status).toBe(401)
  expect((await db.profiles.findUniqueOrThrow({ where: { id } })).name).toBeNull()
  expect(await db.event_rsvps.count({ where: { user_id: id, event_id: future } })).toBe(0)
})

it("leaves every room they were in, and keeps a ban", async () => {
  /*
   * Driven on staging (SCRUM-193): after "Delete my account" the membership
   * row was still `active`, so the room's participants list and headcount
   * kept a person who no longer existed, under their pseudonym.
   */
  const host = await makeUser("dep-host2", "organizer")
  users.push(host)
  const [inRoom, inBannedRoom] = await Promise.all([makeEvent(host), makeEvent(host)])
  events.push(inRoom, inBannedRoom)
  const groups = await Promise.all(
    [inRoom, inBannedRoom].map((event_id) =>
      db.chat_groups.create({ data: { event_id, name: "room", status: "active" }, select: { id: true } })
    )
  )

  const id = await makeUser("dep-leaver2")
  users.push(id)
  await db.profiles.create({ data: { id, name: "Leaver", date_of_birth: new Date("1996-05-12") } })
  await db.chat_group_members.createMany({
    data: [
      { chat_group_id: groups[0].id, user_id: id, status: "active", anonymous_name: "Quiet Heron" },
      { chat_group_id: groups[1].id, user_id: id, status: "banned", anonymous_name: "Quiet Heron" },
    ],
  })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })

  const res = await accountRoute.DELETE(req("DELETE", "/api/mobile/account", signAccessToken(id, email)))
  expect(res.status).toBe(200)

  const rows = await db.chat_group_members.findMany({
    where: { user_id: id },
    select: { chat_group_id: true, status: true, anonymous_name: true },
    orderBy: { chat_group_id: "asc" },
  })
  const byGroup = Object.fromEntries(rows.map((r) => [r.chat_group_id, r]))
  expect(byGroup[groups[0].id].status).toBe("left")
  expect(byGroup[groups[1].id].status).toBe("banned")
  // The pseudonym stays, so the transcript still reads.
  expect(rows.every((r) => r.anonymous_name === "Quiet Heron")).toBe(true)

  await db.chat_group_members.deleteMany({ where: { user_id: id } })
  await db.chat_groups.deleteMany({ where: { id: { in: groups.map((g) => g.id) } } })
})

it("stops being here now in a room they were standing in, and keeps the attendance (SCRUM-481)", async () => {
  /*
   * Driven on staging: three attendees checked in to a live event and deleted
   * their accounts. Their check-ins stayed `checked_in` with no check-out, so
   * the room read "4 here now" to the one person left, and Meet next offered
   * the three erased people under their pseudonyms until the event ended.
   */
  const host = await makeUser("dep-host3", "organizer")
  users.push(host)
  const eventId = await makeEvent(host) // live: started an hour ago
  events.push(eventId)
  const occurrenceId = await occurrenceOf(eventId)

  const [leaver, stayer] = await Promise.all([makeUser("dep-leaver3"), makeUser("dep-stayer3")])
  users.push(leaver, stayer)
  await db.profiles.create({ data: { id: leaver, name: "Leaver", date_of_birth: new Date("1996-05-12") } })
  await putInRoom({ eventId, occurrenceId, userId: leaver })
  await putInRoom({ eventId, occurrenceId, userId: stayer })
  expect((await getOccupancy(eventId)).inside).toBe(2)
  // A second event's check-in still open too: a multi-day event leaves the
  // earlier day's row open beside today's until the sweeper closes it.
  const otherEventId = await makeEvent(host)
  events.push(otherEventId)
  await putInRoom({ eventId: otherEventId, occurrenceId: await occurrenceOf(otherEventId), userId: leaver })

  const { email } = await db.user.findUniqueOrThrow({ where: { id: leaver }, select: { email: true } })
  const res = await accountRoute.DELETE(req("DELETE", "/api/mobile/account", signAccessToken(leaver, email)))
  expect(res.status).toBe(200)

  // Nobody is here who asked to be erased; the one who stayed still is.
  expect((await getOccupancy(eventId)).inside).toBe(1)
  // Attendance is the organiser's history: the row stays, closed.
  const rows = await db.event_check_ins.findMany({
    where: { event_id: eventId },
    select: { user_id: true, status: true, check_out_time: true },
  })
  const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r]))
  expect(byUser[leaver]).toMatchObject({ status: "checked_out" })
  expect(byUser[leaver].check_out_time).not.toBeNull()
  expect(byUser[stayer]).toMatchObject({ status: "checked_in", check_out_time: null })
  const sessions = await db.presence_sessions.findMany({
    where: { event_id: eventId },
    select: { user_id: true, departed_at: true, departed_source: true },
  })
  // They left; nobody inferred it from silence.
  expect(sessions.find((x) => x.user_id === leaver)).toMatchObject({ departed_source: "user" })
  expect(sessions.find((x) => x.user_id === leaver)?.departed_at).not.toBeNull()
  expect(sessions.find((x) => x.user_id === stayer)?.departed_at).toBeNull()
  // And out of the other room as well.
  expect(await db.event_check_ins.count({ where: { user_id: leaver, status: "checked_in" } })).toBe(0)
  expect(await db.presence_sessions.count({ where: { user_id: leaver, departed_at: null } })).toBe(0)

  await db.presence_sessions.deleteMany({ where: { event_id: { in: [eventId, otherEventId] } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: [eventId, otherEventId] } } })
})
