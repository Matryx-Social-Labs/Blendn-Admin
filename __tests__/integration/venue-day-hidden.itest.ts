import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn(), unstable_cache: (fn: unknown) => fn }))
jest.mock("next/headers", () => ({ headers: jest.fn().mockResolvedValue({ get: () => "203.0.113.46" }) }))

type Role = "app_admin" | "organizer" | "venue_owner"
let session: { user: { id: string; role: Role } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
const as = (role: Role, id: string) => {
  session = { user: { id, role } }
}

import { getDashboardOverview } from "@/app/dashboard/actions"
import { eventAttendees } from "@/lib/attendee-roster"
import { signAccessToken } from "@/lib/mobile-auth"
import { actorFor } from "@/lib/org-membership"
import { sendEventReminders, sendRatingRequests } from "@/lib/services/event-notifications.service"
import { venueDayFor } from "@/lib/venue-day"
import { unlinkEventVenue } from "@/lib/venue-link-actions"

import { closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const feed = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
const search = require("@/app/api/mobile/events/search/route") as typeof import("@/app/api/mobile/events/search/route")
const cities = require("@/app/api/mobile/events/cities/route") as typeof import("@/app/api/mobile/events/cities/route")
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
const attendance = require("@/app/api/mobile/me/attendance/route") as typeof import("@/app/api/mobile/me/attendance/route")
const rsvps = require("@/app/api/mobile/me/rsvps/route") as typeof import("@/app/api/mobile/me/rsvps/route")
const claimPage = require("@/app/claim/[eventId]/page") as typeof import("@/app/claim/[eventId]/page")
const dashboardEvents = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
const moderation = require("@/app/api/events/[id]/chat/moderation/route") as typeof import("@/app/api/events/[id]/chat/moderation/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * A venue day is absent from every reader that is not about it (TQ-X06,
 * PL-I16 — the behavioural twin of `events-kind-boundary.test.ts`), and its
 * venue's owner moderates its room without ever seeing who is in it (TQ-DV04,
 * PL-I13, F1).
 *
 * Every absence is paired with a control: a real event at the same venue,
 * matching the same search, in the same city. Without it, an absence proves
 * only that the query found nothing at all.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const TOKEN = `zvd${Date.now().toString(36).replace(/\d/g, "")}q`
const CITY = `Itestcity${TOKEN}`

const users: string[] = []
const events: string[] = []
const venues: string[] = []
const orgs: string[] = []

let venueId: string
let ownerOrg: string
let venueOwner: string
let orgOrganiser: string
let admin: string
let viewer: { id: string; token: string }
let day: { id: string; occurrenceId: string }
let control: string

async function realEvent(data: { start: Date; end: Date; title?: string }) {
  const row = await db.events.create({
    data: {
      slug: testId("vdh"),
      title: data.title ?? `${TOKEN} night`,
      description: `${TOKEN} night`,
      venue_id: venueId,
      venue_name: `${TOKEN} Hall`,
      city: CITY,
      latitude: 12.9716,
      longitude: 77.5946,
      start_time: data.start,
      end_time: data.end,
      timezone: "Asia/Kolkata",
      status: "published",
      visibility: "public",
      organizer_id: orgOrganiser,
    },
  })
  events.push(row.id)
  await db.event_occurrences.create({
    data: { event_id: row.id, occurs_on: new Date(data.start.toISOString().slice(0, 10)), start_time: data.start, end_time: data.end },
  })
  return row.id
}

/** A venue day pushed to a time the sweepers look at — a state only a fixture makes. */
async function venueDayAt(start: Date, end: Date) {
  const v = await db.venues.create({ data: { name: `${TOKEN} Annex ${testId("v")}`, city: CITY, latitude: 12.97, longitude: 77.59 } })
  venues.push(v.id)
  const d = await venueDayFor(v.id)
  await db.events.update({ where: { id: d!.id }, data: { start_time: start, end_time: end } })
  events.push(d!.id)
  return d!.id
}

beforeAll(async () => {
  const org = await db.organisations.create({ data: { display_name: testId("vdh_org"), kind: "company", status: "verified" } })
  ownerOrg = org.id
  orgs.push(org.id)
  const v = await db.venues.create({
    data: {
      name: `${TOKEN} Hall`,
      city: CITY,
      latitude: 12.9716,
      longitude: 77.5946,
      geofence: { type: "circle", lat: 12.9716, lng: 77.5946, radius: 60 },
      owner_org_id: ownerOrg,
      claimed_at: new Date(Date.now() - 30 * 24 * HOUR),
    },
  })
  venueId = v.id
  venues.push(v.id)

  venueOwner = await makeUser("vdh_owner")
  orgOrganiser = await makeUser("vdh_orgorg", "organizer")
  admin = await makeUser("vdh_admin", "app_admin")
  users.push(venueOwner, orgOrganiser, admin)
  await db.user.update({ where: { id: venueOwner }, data: { role: "venue_owner" } })
  await db.organisation_members.createMany({
    data: [
      { org_id: ownerOrg, user_id: venueOwner, role: "owner" },
      { org_id: ownerOrg, user_id: orgOrganiser, role: "staff" },
    ],
  })

  const viewerId = await makeUser("vdh_viewer")
  users.push(viewerId)
  await onboard(viewerId)
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewerId }, select: { email: true } })
  viewer = { id: viewerId, token: signAccessToken(viewerId, email) }

  const d = await venueDayFor(venueId)
  day = { id: d!.id, occurrenceId: d!.occurrenceId }
  events.push(d!.id)
  /*
   * Public, here only. `venueDayFor` makes it unlisted, and every attendee
   * reader below also asks for public — so as written the kind filter would be
   * untested, with the visibility hiding it twice. Public leaves the kind as
   * the one thing between this row and each reader.
   */
  await db.events.update({ where: { id: day.id }, data: { visibility: "public" } })
  control = await realEvent({ start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 3 * HOUR) })

  // The venue day's own row is what most readers would trip on: its owning
  // org is the venue's, as `venueDayFor` writes it for a claimed venue.
  expect((await db.events.findUniqueOrThrow({ where: { id: day.id } })).organizer_org_id).toBe(ownerOrg)
})

afterAll(async () => {
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

const get = (route: { GET: (r: NextRequest) => Promise<Response> }, path: string) =>
  route.GET(new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${viewer.token}` } }))

async function rows(res: Response, key: string): Promise<Array<{ id: string }>> {
  expect(res.status).toBe(200)
  const body = await res.json()
  return Array.isArray(body.data) ? body.data : body.data[key]
}

describe("a venue day never reaches an attendee's discovery (PL-I16)", () => {
  it("is absent from the feed, beside the event at the same venue", async () => {
    const ids = (await rows(await get(feed, `/api/mobile/events?limit=100&search=${TOKEN}`), "events")).map((e) => e.id)
    expect(ids).toContain(control)
    expect(ids).not.toContain(day.id)
  })

  it("is absent from search", async () => {
    const ids = (await rows(await get(search, `/api/mobile/events/search?q=${TOKEN}&limit=100`), "events")).map((e) => e.id)
    expect(ids).toContain(control)
    expect(ids).not.toContain(day.id)
  })

  it("does not count towards its city", async () => {
    const res = await get(cities, "/api/mobile/events/cities")
    const list = (await rows(res, "cities")) as unknown as Array<{ city: string; eventCount: number }>
    expect(list.find((c) => c.city === CITY)?.eventCount).toBe(1)
  })

  it("is not its own venue's upcoming event (F3)", async () => {
    const list = (await rows(await get(venuesRoute, `/api/mobile/venues?search=${TOKEN}%20Hall&limit=50`), "venues")) as unknown as Array<{
      id: string
      upcomingEventCount: number
      nextEvent: { id: string } | null
    }>
    const venue = list.find((v) => v.id === venueId)
    expect(venue?.upcomingEventCount).toBe(1)
    expect(venue?.nextEvent?.id).toBe(control)
  })

  it("takes no RSVP into 'my plans', and stays in 'my nights' as a place (D-6)", async () => {
    await db.event_rsvps.createMany({
      data: [
        { event_id: day.id, user_id: viewer.id, status: "going" },
        { event_id: control, user_id: viewer.id, status: "going" },
      ],
    })
    const planned = (await rows(await get(rsvps, "/api/mobile/me/rsvps?limit=100"), "events")).map((e) => e.id)
    expect(planned).toContain(control)
    expect(planned).not.toContain(day.id)

    await db.event_check_ins.create({
      data: { event_id: day.id, occurrence_id: day.occurrenceId, user_id: viewer.id, status: "checked_in", check_in_time: new Date() },
    })
    const nights = (await rows(await get(attendance, "/api/mobile/me/attendance?limit=100"), "events")).map((e) => e.id)
    expect(nights).toContain(day.id)
  })

  it("has no claim page (404)", async () => {
    const render = (eventId: string) => claimPage.default({ params: Promise.resolve({ eventId }) })
    await expect(render(day.id)).rejects.toMatchObject({ digest: expect.stringContaining("404") })
  })
})

describe("a venue day never reaches a host's or the platform's numbers (PL-I16)", () => {
  it("is absent from the dashboard events list and every overview", async () => {
    as("app_admin", admin)
    const listed = (await (await dashboardEvents.GET(new NextRequest("http://localhost/api/events?limit=100"))).json()) as Array<{ id: string }>
    expect(listed.map((e) => e.id)).not.toContain(day.id)

    for (const [role, id] of [["app_admin", admin], ["organizer", orgOrganiser], ["venue_owner", venueOwner]] as const) {
      as(role, id)
      const text = JSON.stringify(await getDashboardOverview())
      expect(text).not.toContain(day.id)
      expect(text).not.toContain("Venue day ·")
    }
  })

  it("is never reminded about, nor asked to be rated", async () => {
    const now = new Date()
    const soonDay = await venueDayAt(new Date(now.getTime() + 62 * MIN), new Date(now.getTime() + 24 * HOUR))
    const soonEvent = await realEvent({ start: new Date(now.getTime() + 62 * MIN), end: new Date(now.getTime() + 4 * HOUR) })
    await sendEventReminders(60)
    const reminded = await db.events.findMany({ where: { id: { in: [soonDay, soonEvent] } }, select: { id: true, reminded_at: true } })
    expect(reminded.find((e) => e.id === soonEvent)?.reminded_at).not.toBeNull()
    expect(reminded.find((e) => e.id === soonDay)?.reminded_at).toBeNull()

    const endedDay = await venueDayAt(new Date(now.getTime() - 24 * HOUR), new Date(now.getTime() - 10 * MIN))
    const endedEvent = await realEvent({ start: new Date(now.getTime() - 3 * HOUR), end: new Date(now.getTime() - 10 * MIN) })
    await sendRatingRequests(now)
    const asked = await db.events.findMany({ where: { id: { in: [endedDay, endedEvent] } }, select: { id: true, rating_requested_at: true } })
    expect(asked.find((e) => e.id === endedEvent)?.rating_requested_at).not.toBeNull()
    expect(asked.find((e) => e.id === endedDay)?.rating_requested_at).toBeNull()
  })
})

/*
 * F1 / D-1 / PL-I13 / RG-I05. The venue day's org IS the venue owner's, so the
 * default resolver would hand them edit and the roster. The control — a real
 * event at the same venue — is what makes the refusal mean something.
 */
describe("the venue owner on a venue day", () => {
  it("is refused the roster, while still told the count for a host's event in the building", async () => {
    const owner = await actorFor({ id: venueOwner, role: "venue_owner" })
    expect(await eventAttendees(owner, day.id)).toBeNull()
    expect(await eventAttendees(owner, control)).toMatchObject({ view: "count" })

    const platform = await actorFor({ id: admin, role: "app_admin" })
    expect(await eventAttendees(platform, day.id)).toMatchObject({ view: "labels" })
  })

  it("may moderate the room; an organiser of the same organisation may not", async () => {
    await db.chat_groups.create({ data: { event_id: day.id, name: "venue day room" } })
    const open = (id: string) => moderation.GET(new NextRequest(`http://localhost/api/events/${id}/chat/moderation`), { params: Promise.resolve({ id }) })

    as("venue_owner", venueOwner)
    expect((await open(day.id)).status).toBe(200)

    as("organizer", orgOrganiser)
    expect((await open(day.id)).status).toBe(403)

    as("app_admin", admin)
    expect((await open(day.id)).status).toBe(200)
  })

  it("cannot unlink the venue from its own day — nobody can, which would split the room", async () => {
    for (const [role, id] of [["organizer", orgOrganiser], ["app_admin", admin]] as const) {
      as(role, id)
      await expect(unlinkEventVenue(day.id, "testing the venue-day refusal")).rejects.toThrow(/not linked/)
    }
    expect((await db.events.findUniqueOrThrow({ where: { id: day.id } })).venue_id).toBe(venueId)
  })
})
