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
import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"

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
