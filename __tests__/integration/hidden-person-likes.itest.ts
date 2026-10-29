import { NextRequest } from "next/server"

/*
 * SCRUM-669 item 3: "Show online status" off is "counted, not listed" — and not
 * likeable either. The wave route already refused a hidden target; the like
 * route, and a crew's like of a person, answered 200 for someone the roster
 * hides. Both now answer as for an id nobody has, whichever way the hidden
 * person is named (raw id or this room's handle), and write nothing.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-hidden-likes-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { roomHandle } from "@/lib/room-handle"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const likesRoute = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}

const LAT = 12.9716
const LNG = 77.5946
const users: string[] = []
const events: string[] = []

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: unknown, path: string, as: Person, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const res = await (handler as Handler)(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params ?? {}) as Promise<never> }
  )
  return { status: res.status, body: await res.json() }
}

async function liveEvent(): Promise<string> {
  const host = await makeUser(testId("hl-host"), "organizer")
  users.push(host)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("hl"),
      title: "Hidden likes fixture",
      description: "integration fixture",
      start_time: new Date(now - 30 * 60_000),
      end_time: new Date(now + 2 * 60 * 60_000),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: host,
      latitude: LAT,
      longitude: LNG,
      geofence: { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 },
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  return event.id
}

async function checkIn(eventId: string, p: Person) {
  const res = await call(checkinRoute.POST, `/api/mobile/events/${eventId}/checkin`, p, { method: "POST", body: { latitude: LAT, longitude: LNG }, params: { eventId } })
  expect(res.status).toBe(200)
}

afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("a person the roster hides cannot be liked", () => {
  let eventId: string
  let ana: Person, ben: Person, hidden: Person

  const like = (ref: string) =>
    call(likesRoute.POST, `/api/mobile/events/${eventId}/matches/likes`, ana, { method: "POST", body: { userId: ref }, params: { eventId } })

  beforeAll(async () => {
    eventId = await liveEvent()
    ;[ana, ben, hidden] = [await person("hl-ana"), await person("hl-ben"), await person("hl-hid")]
    await db.profiles.update({ where: { id: hidden.id }, data: { show_online: false } })
    for (const p of [ana, ben, hidden]) await checkIn(eventId, p)
  })

  it("a visible person in the same room can be liked (control)", async () => {
    const res = await like(roomHandle(eventId, ben.id))
    expect(res.status).toBe(200)
    expect(await db.event_likes.count({ where: { liker_id: ana.id, liked_id: ben.id } })).toBe(1)
  })

  it("a hidden person is answered as an id nobody has, by handle and by raw id, and nothing is written", async () => {
    const nobody = await like(testId("hl-nobody"))
    expect(nobody.status).toBe(404)
    expect(await like(roomHandle(eventId, hidden.id))).toEqual(nobody)
    expect(await like(hidden.id)).toEqual(nobody)
    expect(await db.event_likes.count({ where: { liker_id: ana.id, liked_id: hidden.id } })).toBe(0)
  })

  it("turning the setting back on makes them likeable again", async () => {
    await db.profiles.update({ where: { id: hidden.id }, data: { show_online: true } })
    try {
      expect((await like(roomHandle(eventId, hidden.id))).status).toBe(200)
      expect(await db.event_likes.count({ where: { liker_id: ana.id, liked_id: hidden.id } })).toBe(1)
    } finally {
      await db.event_likes.deleteMany({ where: { liker_id: ana.id } })
      await db.profiles.update({ where: { id: hidden.id }, data: { show_online: false } })
    }
  })
})
