import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * The events behind the app's Going tab.
 *
 * Every fixture exists to tell a right answer from a plausible wrong one: an
 * RSVP the list must include next to one it must not, for each rule — status,
 * time, event state, and whose RSVP it is. A suite of only-going, only-future
 * rows would pass an implementation that filtered nothing.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const meRsvps = require("@/app/api/mobile/me/rsvps/route") as
  typeof import("@/app/api/mobile/me/rsvps/route")

const users: string[] = []
const events: string[] = []
const DAY = 24 * 60 * 60 * 1000

afterAll(async () => {
  if (events.length) {
    await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function event(
  label: string,
  startsInDays: number,
  opts: { status?: "published" | "cancelled" | "draft"; deleted?: boolean } = {}
) {
  const start = new Date(Date.now() + startsInDays * DAY)
  const e = await db.events.create({
    data: {
      slug: testId(label),
      title: `${label} ${testId("t")}`,
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + 4 * 60 * 60 * 1000),
      timezone: "UTC",
      status: opts.status ?? "published",
      organizer_id: users[0],
      deleted_at: opts.deleted ? new Date() : null,
    },
  })
  events.push(e.id)
  return e
}

const rsvp = (userId: string, eventId: string, status: "going" | "waitlisted" | "maybe" | "not_going") =>
  db.event_rsvps.create({ data: { event_id: eventId, user_id: userId, status } })

const fetchMine = (token: string | null, qs = "") =>
  meRsvps.GET(
    new NextRequest(`http://localhost/api/mobile/me/rsvps${qs}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  )

describe("GET /me/rsvps", () => {
  let me: string
  let token: string
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    users.push(await makeUser(testId("rsvp_own"), "organizer"))
    me = await makeUser(testId("rsvp_me"))
    users.push(me)
    const other = await makeUser(testId("rsvp_other"))
    users.push(other)
    const u = await db.user.findUniqueOrThrow({ where: { id: me }, select: { email: true } })
    token = signAccessToken(me, u.email)

    const later = await event("later", 9)
    const soon = await event("soon", 2)
    const waitlisted = await event("full", 5)
    const cancelled = await event("cancelled", 3, { status: "cancelled" })
    const maybe = await event("maybe", 4)
    const past = await event("past", -3)
    const draft = await event("draft", 6, { status: "draft" })
    const deleted = await event("deleted", 7, { deleted: true })
    const theirs = await event("theirs", 1)
    Object.assign(ids, {
      later: later.id,
      soon: soon.id,
      waitlisted: waitlisted.id,
      cancelled: cancelled.id,
      maybe: maybe.id,
      past: past.id,
      draft: draft.id,
      deleted: deleted.id,
      theirs: theirs.id,
    })

    await rsvp(me, later.id, "going")
    await rsvp(me, soon.id, "going")
    await rsvp(me, waitlisted.id, "waitlisted")
    await rsvp(me, cancelled.id, "going")
    await rsvp(me, maybe.id, "maybe")
    await rsvp(me, past.id, "going")
    await rsvp(me, draft.id, "going")
    await rsvp(me, deleted.id, "going")
    await rsvp(other, theirs.id, "going")
  })

  it("refuses without a token", async () => {
    expect((await fetchMine(null)).status).toBe(401)
  })

  it("lists upcoming going and waitlisted RSVPs, soonest first, and nothing else", async () => {
    const res = await fetchMine(token, "?limit=50")
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data.events.map((e: { id: string }) => e.id)).toEqual([
      ids.soon,
      ids.cancelled,
      ids.waitlisted,
      ids.later,
    ])
    expect(body.data.pagination.totalCount).toBe(4)
  })

  it("says which RSVPs are only on the waitlist", async () => {
    const body = await (await fetchMine(token, "?limit=50")).json()
    const byId = new Map(body.data.events.map((e: { id: string; rsvpStatus: string }) => [e.id, e.rsvpStatus]))
    expect(byId.get(ids.waitlisted)).toBe("waitlisted")
    expect(byId.get(ids.soon)).toBe("going")
  })

  it("keeps a cancelled event, marked cancelled", async () => {
    const body = await (await fetchMine(token, "?limit=50")).json()
    const cancelled = body.data.events.find((e: { id: string }) => e.id === ids.cancelled)
    expect(cancelled.status).toBe("cancelled")
  })

  it("uses the favourites route's field names, so the app reads both lists alike", async () => {
    const body = await (await fetchMine(token, "?limit=1")).json()
    expect(Object.keys(body.data.events[0])).toEqual(
      expect.arrayContaining([
        "id", "title", "venueName", "address", "startTime", "endTime",
        "coverImageUrl", "coverImage", "latitude", "longitude", "status",
      ])
    )
    expect(body.data.pagination).toMatchObject({ page: 1, limit: 1, totalCount: 4, hasMore: true })
  })
})
