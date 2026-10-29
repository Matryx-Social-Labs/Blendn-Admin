let session: { user: { id: string; role: string } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => (session?.user ? { ...session, user: { signedInAt: 0, ...session.user } } : session) }))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-input-gaps-secret-of-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { NextRequest } from "next/server"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, makeEvent, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const presenceRoute = require("@/app/api/mobile/events/[eventId]/presence/route") as typeof import("@/app/api/mobile/events/[eventId]/presence/route")
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/*
 * SCRUM-653: two requests that got the wrong status. A presence ping whose body
 * is the JSON `null` threw on destructuring and answered 500; `GET /api/events`
 * took `?limit=-5` into Prisma's `take`, which reverses the window, and `0`
 * into the maximum without saying so.
 */
const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

describe("a presence ping with a body that is not an object", () => {
  it.each([["null", "null"], ["a number", "7"], ["a string", '"hi"'], ["an array", "[1,2]"]])("answers 400 for %s", async (_label, raw) => {
    const id = await makeUser(testId("rig-p"))
    users.push(id)
    await onboard(id)
    const host = await makeUser(testId("rig-h"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const res = await presenceRoute.POST(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(id, `${id}@itest.invalid`)}` },
        body: raw,
      }),
      { params: Promise.resolve({ eventId }) }
    )
    expect({ status: res.status, error: (await res.json()).error }).toEqual({ status: 400, error: "latitude and longitude are required" })
  })
})

describe("GET /api/events ?limit", () => {
  it("never reverses the window, and never turns 0 into everything", async () => {
    const admin = await makeUser(testId("rig-a"), "app_admin")
    users.push(admin)
    session = { user: { id: admin, role: "app_admin" } }
    const host = await makeUser(testId("rig-h2"), "organizer")
    users.push(host)
    for (let i = 0; i < 3; i++) events.push(await makeEvent(host))
    const get = async (q: string) => {
      const res = await eventsRoute.GET(new NextRequest(`http://localhost/api/events${q}`))
      return { status: res.status, body: (await res.json()) as unknown[] }
    }
    const [one, neg, zero, big] = [await get("?limit=1"), await get("?limit=-5"), await get("?limit=0"), await get("?limit=3")]
    expect(one.body).toHaveLength(1)
    // -5 and 0 are "not a usable limit": the smallest page, not a reversed or unbounded one.
    expect(neg.status).toBe(200)
    expect(neg.body).toHaveLength(1)
    expect(zero.body).toHaveLength(1)
    expect(big.body.length).toBeGreaterThanOrEqual(3)
  })
})
