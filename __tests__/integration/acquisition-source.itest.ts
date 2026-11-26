import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/push-notifications", () => ({ sendPushNotification: jest.fn(async () => true) }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { signAccessToken } from "@/lib/mobile-auth"
import { flushProductEvents, resetProductEventCache } from "@/lib/product-events"

import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/**
 * SCRUM-1273 (insights/02): where a view, an RSVP and a sign-up came from, against real Postgres.
 *
 * - `GET /events/:id?s=` records the source on `event_viewed`, and only once access is granted: a denied view
 *   counted (the record sat above `attendeeEventAccess`).
 * - `POST /events/:id/rsvp { source }` writes it on the row's first insert; a later status change keeps it.
 * - `PUT /profiles/:id { source }` writes `signup_source` once; the first install source wins.
 * - An unknown source is no source: 200 and NULL, never a refusal.
 * - The installed pilot build sends none of these, and must see exactly what it saw before.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const detail = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
const rsvp = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
const profile = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.product_events.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

beforeEach(resetProductEventCache)

let host = ""
beforeAll(async () => {
  host = await makeUser(testId("acq-host"), "organizer")
  users.push(host)
})

async function guest(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

async function event() {
  const id = await makeEvent(host)
  events.push(id)
  return id
}

const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" })

const view = (eventId: string, token: string, query = "") =>
  detail.GET(new NextRequest(`http://localhost/api/mobile/events/${eventId}${query}`, { headers: auth(token) }), {
    params: Promise.resolve({ eventId }),
  })

const post = (eventId: string, token: string, body: unknown) =>
  rsvp.POST(new NextRequest(`http://localhost/api/mobile/events/${eventId}/rsvp`, { method: "POST", headers: auth(token), body: JSON.stringify(body) }), {
    params: Promise.resolve({ eventId }),
  })

const put = (userId: string, token: string, body: unknown) =>
  profile.PUT(new NextRequest(`http://localhost/api/mobile/profiles/${userId}`, { method: "PUT", headers: auth(token), body: JSON.stringify(body) }), {
    params: Promise.resolve({ userId }),
  })

const viewRows = async (userId: string, eventId: string) => {
  await flushProductEvents()
  return db.product_events.findMany({ where: { user_id: userId, name: "event_viewed", entity_id: eventId }, select: { props: true } })
}
const rsvpSource = async (eventId: string, userId: string) =>
  (await db.event_rsvps.findUniqueOrThrow({ where: { event_id_user_id: { event_id: eventId, user_id: userId } }, select: { source: true, status: true } }))
const signupSource = async (userId: string) => (await db.profiles.findUniqueOrThrow({ where: { id: userId }, select: { signup_source: true } })).signup_source

/** Timestamps move between two calls; everything else in a response must not. */
const settled = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, v) => (/_at$|At$/.test(key) ? undefined : v))

describe("GET /events/:id?s=", () => {
  it("records the source on the view", async () => {
    const me = await guest("acq-view")
    const eventId = await event()
    expect((await view(eventId, me.token, "?s=door")).status).toBe(200)
    expect(await viewRows(me.id, eventId)).toEqual([{ props: { source: "door" } }])
  })

  it("records a view with no props when there is no tag, and answers exactly as it does with one", async () => {
    const me = await guest("acq-view-bare")
    const eventId = await event()
    const bare = await view(eventId, me.token)
    expect(bare.status).toBe(200)
    expect(await viewRows(me.id, eventId)).toEqual([{ props: null }])
    const tagged = await view(eventId, me.token, "?s=door")
    expect(settled(await tagged.json())).toEqual(settled(await bare.json()))
  })

  it.each(["?s=DOOR", "?s=x", `?s=${"d".repeat(200)}`, "?s=door&s=link"])("ignores %s: 200, a view, no source", async (query) => {
    const me = await guest("acq-view-odd")
    const eventId = await event()
    expect((await view(eventId, me.token, query)).status).toBe(200)
    const rows = await viewRows(me.id, eventId)
    expect(rows).toHaveLength(1)
    // `?s=door&s=link` reads the first value, as URLSearchParams.get does.
    expect(rows[0].props).toEqual(query === "?s=door&s=link" ? { source: "door" } : null)
  })

  it("counts no view the person was refused", async () => {
    // Negative control: on the code before SCRUM-1273 this wrote a row, because `record` ran above the access check.
    const me = await guest("acq-view-denied")
    const eventId = await event()
    await db.events.update({ where: { id: eventId }, data: { status: "draft" } })
    expect((await view(eventId, me.token, "?s=door")).status).toBe(404)
    expect(await viewRows(me.id, eventId)).toEqual([])
  })
})

describe("POST /events/:id/rsvp { source }", () => {
  it("writes the source on the first RSVP and keeps it through a later not_going", async () => {
    const me = await guest("acq-rsvp")
    const eventId = await event()
    expect((await post(eventId, me.token, { status: "going", source: "door" })).status).toBe(200)
    expect(await rsvpSource(eventId, me.id)).toEqual({ status: "going", source: "door" })

    expect((await post(eventId, me.token, { status: "not_going", source: "link" })).status).toBe(200)
    expect(await rsvpSource(eventId, me.id)).toEqual({ status: "not_going", source: "door" })
  })

  it.each([{ source: "x" }, { source: "DOOR" }, { source: 7 }, { source: null }])("takes the RSVP with %p and stores no source", async (extra) => {
    const me = await guest("acq-rsvp-odd")
    const eventId = await event()
    const res = await post(eventId, me.token, { status: "going", ...extra })
    expect(res.status).toBe(200)
    expect(await rsvpSource(eventId, me.id)).toEqual({ status: "going", source: null })
  })

  it("answers an RSVP with no source exactly as before, and stores none", async () => {
    // The installed pilot build's request.
    const me = await guest("acq-rsvp-bare")
    const eventId = await event()
    const res = await post(eventId, me.token, { status: "going" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { rsvpStatus: "going", rsvpCount: 1 } })
    expect(await rsvpSource(eventId, me.id)).toEqual({ status: "going", source: null })
  })
})

describe("PUT /profiles/:id { source }", () => {
  it("keeps the first install source: door, then link, leaves door", async () => {
    const me = await guest("acq-profile")
    expect((await put(me.id, me.token, { source: "door" })).status).toBe(200)
    expect(await signupSource(me.id)).toBe("door")
    expect((await put(me.id, me.token, { source: "link" })).status).toBe(200)
    expect(await signupSource(me.id)).toBe("door")
  })

  it("writes a source onto a profile that has none yet, alongside the rest of the save", async () => {
    const me = await guest("acq-profile-first")
    expect((await put(me.id, me.token, { bio: "hello", source: "share" })).status).toBe(200)
    expect(await db.profiles.findUniqueOrThrow({ where: { id: me.id }, select: { bio: true, signup_source: true } })).toEqual({ bio: "hello", signup_source: "share" })
  })

  it.each([{ source: "x" }, { source: "door " }, { source: 1 }])("saves the profile with %p and stores no source", async (extra) => {
    const me = await guest("acq-profile-odd")
    expect((await put(me.id, me.token, { bio: "still saved", ...extra })).status).toBe(200)
    expect(await db.profiles.findUniqueOrThrow({ where: { id: me.id }, select: { bio: true, signup_source: true } })).toEqual({ bio: "still saved", signup_source: null })
  })

  it("answers a save with no source exactly as one with a source, never reading the source back", async () => {
    const me = await guest("acq-profile-bare")
    const bare = await put(me.id, me.token, { bio: "same" })
    expect(bare.status).toBe(200)
    expect(await signupSource(me.id)).toBeNull()
    const bareBody = await bare.json()
    expect(bareBody.data.profile).not.toHaveProperty("signup_source")

    const tagged = await put(me.id, me.token, { bio: "same", source: "door" })
    expect(await signupSource(me.id)).toBe("door")
    expect(settled(await tagged.json())).toEqual(settled(bareBody))
  })
})
