/**
 * A read never calls Nominatim, and never shows coordinates (SCRUM-1229), on a
 * db:migrate database through the real routes. Only the profile write geocodes,
 * once, and a failed geocode leaves the stored city alone.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-redesign-secret-of-32-characters-x"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { resetMemoryStore } from "@/lib/rate-limit-store"
import { db } from "./helpers"
import { arrive, call, cleanupCrewWorld, liveEvent, person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const sessionRoute = require("@/app/api/mobile/auth/session/route") as typeof import("@/app/api/mobile/auth/session/route")
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
const checkinsRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const COORDS = "12.969521,77.535842"

/* Every request the process makes is counted; Nominatim's are answered here. */
const realFetch = global.fetch
const nominatim: string[] = []
let nominatimAnswer: () => Promise<Response> = async () => Response.json({ address: { city: "Bengaluru" } })
beforeAll(() => {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes("nominatim")) {
      nominatim.push(url)
      return nominatimAnswer()
    }
    return realFetch(input, init)
  }) as typeof fetch
})
afterAll(async () => {
  global.fetch = realFetch
  await cleanupCrewWorld()
})
beforeEach(() => {
  resetMemoryStore()
  nominatim.length = 0
})

const location = (id: string) => db.profiles.findUniqueOrThrow({ where: { id }, select: { location: true } }).then((p) => p.location)

describe("reads", () => {
  it("serve a coordinate-shaped location as null, to its owner and to anybody else, with no request", async () => {
    const asha = await person("geo-asha")
    const ravi = await person("geo-ravi")
    await db.profiles.update({ where: { id: asha.id }, data: { location: COORDS } })
    const host = await person("geo-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    await arrive(eventId, occurrenceId, asha)
    await arrive(eventId, occurrenceId, ravi)

    const byOther = await call(profileRoute.GET, `/api/mobile/profiles/${asha.id}`, ravi, { params: { userId: asha.id } })
    const own = await call(profileRoute.GET, `/api/mobile/profiles/${asha.id}`, asha, { params: { userId: asha.id } })
    const session = await call(sessionRoute.GET, "/api/mobile/auth/session", asha)
    const room = await call(checkinsRoute.GET, `/api/mobile/events/${eventId}/checkins`, ravi, { params: { eventId } })

    for (const res of [byOther, own, session, room]) expect(res.status).toBe(200)
    expect(own.body.data.profile.location).toBeNull()
    expect(session.body.data.profile.location).toBeNull()
    expect(byOther.body.data.profile?.location ?? byOther.body.data.location ?? null).toBeNull()
    expect(room.body.data.attendees.length).toBeGreaterThan(0)
    for (const a of room.body.data.attendees) expect(a.location).toBeNull()
    for (const res of [byOther, own, session, room]) expect(JSON.stringify(res.body)).not.toContain("12.96")
    expect(nominatim).toEqual([])
    // Nothing was written either: the row heals on the next save, not on a read.
    expect(await location(asha.id)).toBe(COORDS)
  })

  it("serve an event with no city as no city, rather than geocoding its pin", async () => {
    const host = await person("geo-host2")
    const viewer = await person("geo-viewer")
    const { eventId } = await liveEvent(host.id)
    await db.events.update({ where: { id: eventId }, data: { city: null, latitude: 12.97, longitude: 77.59 } })

    const detail = await call(eventRoute.GET, `/api/mobile/events/${eventId}`, viewer, { params: { eventId } })

    expect(detail.status).toBe(200)
    expect(detail.body.data.city).toBeNull()
    expect(nominatim).toEqual([])
  })
})

describe("the profile write", () => {
  const put = (who: Awaited<ReturnType<typeof person>>, body: Record<string, unknown>) =>
    call(profileRoute.PUT, `/api/mobile/profiles/${who.id}`, who, { method: "PUT", body, params: { userId: who.id } })

  it("geocodes coordinates once and stores the city", async () => {
    const asha = await person("geo-put")
    const res = await put(asha, { location: COORDS })
    expect(res.status).toBe(200)
    expect(nominatim).toHaveLength(1)
    expect(await location(asha.id)).toBe("Bengaluru")
  })

  it("keeps the stored city when the geocode fails, and still saves the rest", async () => {
    const asha = await person("geo-put-fail")
    await db.profiles.update({ where: { id: asha.id }, data: { location: "Mysuru" } })
    nominatimAnswer = async () => new Response("busy", { status: 503 })
    try {
      const res = await put(asha, { location: COORDS, bio: "still saved" })
      expect(res.status).toBe(200)
    } finally {
      nominatimAnswer = async () => Response.json({ address: { city: "Bengaluru" } })
    }
    expect(nominatim).toHaveLength(1)
    const row = await db.profiles.findUniqueOrThrow({ where: { id: asha.id }, select: { location: true, bio: true } })
    expect(row).toEqual({ location: "Mysuru", bio: "still saved" })
  })
})
