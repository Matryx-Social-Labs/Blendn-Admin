import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { closeDb, db, makeUser, testId } from "./helpers"

/**
 * SCRUM-877: `GET /events?startBefore=` -- a bound on when an event STARTS.
 *
 * The list's own window is end-based (`endDate`: ends before; and "not ended
 * yet" unless `includePast`), so a "next 7 days" screen could not stop a long
 * event that started weeks ago and runs on, nor bound a far-future start. With
 * `startDate` (starts at or after) and `startBefore` (starts at or before) a
 * caller bounds by start on both sides. Additive: absent, nothing changes.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const listRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")

const DAY = 24 * 60 * 60 * 1000
const users: string[] = []
const events: string[] = []
let auth = ""
let word = ""
const ids: Record<"inside" | "after" | "startedEarlierEndsInside" | "startedLongAgoRunsOn", string> = {} as never

async function eventAt(startsInDays: number, endsInDays: number, label: string) {
  const start = new Date(Date.now() + startsInDays * DAY)
  const end = new Date(Date.now() + endsInDays * DAY)
  const row = await db.events.create({
    data: {
      slug: testId("sb"),
      title: `${word} ${label}`,
      description: `${word} ${label}`,
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: users[0],
    },
  })
  events.push(row.id)
  await db.event_occurrences.create({
    data: { event_id: row.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  return row.id
}

beforeAll(async () => {
  users.push(await makeUser(testId("sb_host"), "organizer"))
  const viewer = await makeUser(testId("sb_viewer"))
  users.push(viewer)
  await db.profiles.create({ data: { id: viewer, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  auth = signAccessToken(viewer, email)
  // A word of our own: the list is cached by its inputs, and this scopes the assertions to these fixtures.
  word = `zqx${Date.now().toString(36).replace(/\d/g, "")}sb`
  ids.inside = await eventAt(2, 2.1, "inside")
  ids.after = await eventAt(10, 10.1, "after")
  ids.startedEarlierEndsInside = await eventAt(-1, 3, "earlier")
  ids.startedLongAgoRunsOn = await eventAt(-30, 20, "longago")
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function listed(query: string): Promise<{ status: number; ids: string[] }> {
  const res = await listRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events?limit=100&search=${word}${query}`, { headers: { authorization: `Bearer ${auth}` } })
  )
  const body = await res.json()
  return { status: res.status, ids: res.status === 200 ? (body.data.events as { id: string }[]).map((e) => e.id) : [] }
}
const iso = (days: number) => encodeURIComponent(new Date(Date.now() + days * DAY).toISOString())

describe("GET /events?startBefore=", () => {
  it("lists what starts at or before the bound and not what starts after it", async () => {
    const { ids: got } = await listed(`&startBefore=${iso(7)}`)
    expect(got).toContain(ids.inside)
    expect(got).not.toContain(ids.after)
  })

  it("still applies the existing end filter: an event that started earlier and has not ended is listed, an ended one is not", async () => {
    const { ids: got } = await listed(`&startBefore=${iso(7)}`)
    expect(got).toContain(ids.startedEarlierEndsInside)
    expect(got).toContain(ids.startedLongAgoRunsOn) // start-bound alone cannot drop it: that is startDate's job
  })

  it("with startDate it bounds by start on both sides: 'the next 7 days' is only what starts in them", async () => {
    const { ids: got } = await listed(`&startDate=${iso(0)}&startBefore=${iso(7)}`)
    expect(got).toEqual([ids.inside])
  })

  it("is additive: without it the list is what it was", async () => {
    const { ids: got } = await listed("")
    expect(got).toEqual(expect.arrayContaining([ids.inside, ids.after, ids.startedEarlierEndsInside, ids.startedLongAgoRunsOn]))
  })

  it("is not served from another bound's cache entry", async () => {
    const wide = await listed(`&startBefore=${iso(30)}`)
    const narrow = await listed(`&startBefore=${iso(7)}`)
    expect(wide.ids).toContain(ids.after)
    expect(narrow.ids).not.toContain(ids.after)
  })

  it("refuses something that is not a datetime with a 400, like startDate", async () => {
    expect((await listed("&startBefore=next-week")).status).toBe(400)
  })
})
