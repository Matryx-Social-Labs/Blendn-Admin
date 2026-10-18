/*
 * The server changes the client redesign needs for venues and offers, on a
 * migrate-deploy database: the venue page's own facts and its `upcoming`
 * events (and what they leave out), `live.stayUntil`, "live first" in the
 * Places list, `regulars: { active, eligible }`, and `redeemedAt` on an offer.
 */
process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { NextRequest } from "next/server"

import { myOffers } from "@/lib/offers/person"
import { signAccessToken } from "@/lib/mobile-auth"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { venueDayBounds } from "@/lib/venue-day"
import { venueDayFor } from "@/lib/venue-day"

import { closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const detail = require("@/app/api/mobile/venues/[venueId]/route") as typeof import("@/app/api/mobile/venues/[venueId]/route")
const list = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
const regular = require("@/app/api/mobile/venues/[venueId]/regular/route") as typeof import("@/app/api/mobile/venues/[venueId]/regular/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const DAY = 86_400_000
const HOUR = 3_600_000
const TOKEN = `zrv${Date.now().toString(36).replace(/\d/g, "")}q`

const users: string[] = []
const venues: string[] = []
const events: string[] = []
const orgs: string[] = []
let viewer: { id: string; token: string }
let host: string
let orgId: string

async function adult(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { age: 30, name: `Person ${label}` } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function venue(name: string, data: Record<string, unknown> = {}) {
  const v = await db.venues.create({
    data: {
      name: `${TOKEN} ${name}`,
      city: `City${TOKEN}`,
      latitude: 12.97,
      longitude: 77.59,
      timezone: "UTC",
      day_reset_hour: 6,
      geofence: { type: "circle", lat: 12.97, lng: 77.59, radius: 60 },
      owner_org_id: orgId,
      claimed_at: new Date(Date.now() - 60 * DAY),
      ...data,
    },
  })
  venues.push(v.id)
  return v.id
}

async function eventAt(venueId: string, startsInHours: number, data: Record<string, unknown> = {}) {
  const id = await makeEvent(host)
  events.push(id)
  await db.events.update({
    where: { id },
    data: {
      venue_id: venueId,
      start_time: new Date(Date.now() + startsInHours * HOUR),
      end_time: new Date(Date.now() + (startsInHours + 2) * HOUR),
      ...data,
    },
  })
  return id
}

const get = (route: { GET: (r: NextRequest, c: { params: Promise<never> }) => Promise<Response> }, path: string, who = viewer, params: Record<string, string> = {}) =>
  route.GET(new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${who.token}` } }), { params: Promise.resolve(params) as Promise<never> })
const body = async (res: Response) => ({ status: res.status, data: (await res.json()).data })

beforeAll(async () => {
  host = await makeUser(testId("rv_host"))
  users.push(host)
  orgId = (await db.organisations.create({ data: { display_name: testId("rv_org"), kind: "company", status: "verified" } })).id
  orgs.push(orgId)
  viewer = await adult("rv_viewer")
})
beforeEach(() => resetMemoryStore())
afterAll(async () => {
  await db.venue_offer_sends.deleteMany({ where: { venue_id: { in: venues } } })
  await db.venue_offers.deleteMany({ where: { venue_id: { in: venues } } })
  const dayIds = (await db.events.findMany({ where: { venue_id: { in: venues } }, select: { id: true } })).map((e) => e.id)
  await db.chat_groups.deleteMany({ where: { event_id: { in: dayIds } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: dayIds } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: dayIds } } })
  await db.events.deleteMany({ where: { id: { in: dayIds } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
}, 60_000)

describe("GET /venues/:id carries the venue page's facts", () => {
  it("returns hours, description, amenities, capacity and dayResetHour as set, and null / [] when not", async () => {
    const hours = [{ day: 5, open: "17:00", close: "01:00" }]
    const full = await venue("Full", { capacity: 80, hours, description: "A rooftop.", amenities: ["Wi-Fi", "Outdoor seating"] })
    const bare = await venue("Bare")
    const garbled = await venue("Garbled", { hours: { monday: "late" } })

    const a = await body(await get(detail, `/api/mobile/venues/${full}`, viewer, { venueId: full }))
    expect(a.data.venue).toMatchObject({ capacity: 80, dayResetHour: 6, hours, description: "A rooftop.", amenities: ["Wi-Fi", "Outdoor seating"], upcoming: [] })
    const b = await body(await get(detail, `/api/mobile/venues/${bare}`, viewer, { venueId: bare }))
    expect(b.data.venue).toMatchObject({ capacity: null, hours: null, description: null, amenities: [] })
    // A value that is not the documented shape reads as not given, never a broken page.
    const c = await body(await get(detail, `/api/mobile/venues/${garbled}`, viewer, { venueId: garbled }))
    expect(c.data.venue.hours).toBeNull()
  })

  it("`upcoming` is the next public events, soonest first, and leaves out what the Places card leaves out", async () => {
    const v = await venue("Upcoming")
    const later = await eventAt(v, 50)
    const sooner = await eventAt(v, 5)
    const control = await eventAt(v, 30)
    // Each of these must be absent, beside the control that is present.
    await eventAt(v, 10, { visibility: "private" })
    await eventAt(v, 11, { status: "draft" })
    await eventAt(v, 12, { venue_link_status: "disputed" })
    await eventAt(v, 13, { min_age: 40 })
    await eventAt(v, 14, { deleted_at: new Date() })
    await eventAt(v, -9) // ended
    const day = await venueDayFor(v)
    if (day) events.push(day.id)

    const res = await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))
    expect(res.data.venue.upcoming.map((e: { id: string }) => e.id)).toEqual([sooner, control, later])
    expect(res.data.venue.upcoming[0]).toEqual({
      id: sooner,
      title: expect.any(String),
      slug: expect.any(String),
      coverImageUrl: null,
      startTime: expect.any(String),
      endTime: expect.any(String),
    })
    // The same events the Places card counts for this venue.
    const card = (await body(await get(list, `/api/mobile/venues?search=${TOKEN}%20Upcoming`))).data.venues[0]
    expect(card.upcomingEventCount).toBe(3)
  })

  it("lists at most five", async () => {
    const v = await venue("Many")
    for (let i = 1; i <= 7; i++) await eventAt(v, i * 3)
    const res = await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))
    expect(res.data.venue.upcoming).toHaveLength(5)
  })

  it("`live.stayUntil` is your own window's ceiling, null when you are not live", async () => {
    const v = await venue("Stay")
    const before = await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))
    expect(before.data.live.stayUntil).toBeNull()
    const day = (await venueDayFor(v))!
    events.push(day.id)
    const until = new Date(Date.now() + 3 * HOUR)
    await db.event_check_ins.create({
      data: {
        event_id: day.id,
        occurrence_id: await occurrenceOf(day.id),
        user_id: viewer.id,
        kind: "attendee",
        status: "checked_in",
        expires_at: new Date(Date.now() + HOUR),
        stay: true,
        stay_until: until,
      },
    })
    const now = await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))
    expect(now.data.live).toMatchObject({ youAreLive: true, stay: true, stayUntil: until.toISOString() })
    await db.event_check_ins.deleteMany({ where: { event_id: day.id } })
  })
})

describe("GET /venues?order=live", () => {
  it("puts the venue somebody is live at first, across pages, and the order is the name order otherwise", async () => {
    const quiet = await venue("zl A quiet")
    const quiet2 = await venue("zl B quiet")
    const busy = await venue("zl Z busy")
    const day = (await venueDayFor(busy))!
    events.push(day.id)
    const occ = await occurrenceOf(day.id)
    for (let i = 0; i < 5; i++) {
      const p = await adult(`rv_live${i}`)
      await db.event_check_ins.create({
        data: { event_id: day.id, occurrence_id: occ, user_id: p.id, kind: "attendee", status: "checked_in", expires_at: new Date(Date.now() + HOUR) },
      })
    }
    const ids = async (qs: string) => (await body(await get(list, `/api/mobile/venues?search=${TOKEN}%20zl&${qs}`))).data.venues.map((v: { id: string }) => v.id)

    expect(await ids("limit=2")).toEqual([quiet, quiet2])
    expect(await ids("order=live&limit=2&page=1")).toEqual([busy, quiet])
    expect(await ids("order=live&limit=2&page=2")).toEqual([quiet2])
    expect((await ids("order=live&limit=1&page=1"))[0]).toBe(busy)
    // The label the card shows is what the order follows.
    const top = (await body(await get(list, `/api/mobile/venues?search=${TOKEN}%20zl&order=live&limit=1`))).data.venues[0]
    expect(top).toMatchObject({ id: busy, liveNow: "5-9" })
    // By distance too.
    expect((await ids("order=live&sortBy=distance&lat=12.97&lon=77.59&limit=1"))[0]).toBe(busy)
  })
})

describe("regulars: { active, eligible }", () => {
  const today = () => venueDayBounds("UTC", 6, new Date()).start
  async function night(venueId: string, userId: string, k: number) {
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { venue_id: venueId } })
    await db.event_check_ins.create({
      data: {
        event_id: eventId,
        occurrence_id: await occurrenceOf(eventId),
        user_id: userId,
        kind: "attendee",
        status: "checked_out",
        check_in_time: new Date(today().getTime() - k * DAY + 14 * HOUR),
      },
    })
  }
  const prefs = async (v: string, who = viewer) => body(await get(regular, `/api/mobile/venues/${v}/regular`, who, { venueId: v }))

  it("is never active; eligible after three nights in 30, from the claim on", async () => {
    const v = await venue("Regulars")
    const p = await adult("rv_reg")
    expect((await prefs(v, p)).data.regulars).toEqual({ active: false, eligible: false })
    await night(v, p.id, 1)
    await night(v, p.id, 2)
    expect((await prefs(v, p)).data.regulars.eligible).toBe(false)
    await night(v, p.id, 3)
    expect((await prefs(v, p)).data.regulars).toEqual({ active: false, eligible: true })
    // Their own data: another person's nights make nobody else eligible.
    expect((await prefs(v, viewer)).data.regulars.eligible).toBe(false)
    // PUT answers the same, and saying yes does not switch the feature on.
    const put = await regular.PUT(
      new NextRequest(`http://localhost/api/mobile/venues/${v}/regular`, {
        method: "PUT",
        headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" },
        body: JSON.stringify({ known: true }),
      }),
      { params: Promise.resolve({ venueId: v }) }
    )
    expect((await put.json()).data).toMatchObject({ known: true, regulars: { active: false, eligible: true } })
  })

  it("nights before the claim never count, and an unclaimed venue has no regulars", async () => {
    const claimedYesterday = await venue("Fresh claim", { claimed_at: new Date(Date.now() - 2 * HOUR) })
    const unclaimed = await venue("Unclaimed", { owner_org_id: null, claimed_at: null })
    const p = await adult("rv_pre")
    for (const k of [1, 2, 3]) {
      await night(claimedYesterday, p.id, k)
      await night(unclaimed, p.id, k)
    }
    expect((await prefs(claimedYesterday, p)).data.regulars.eligible).toBe(false)
    expect((await prefs(unclaimed, p)).data.regulars).toEqual({ active: false, eligible: false })
  })
})

describe("an offer says when it was redeemed", () => {
  it("`redeemedAt` is null until the pass was redeemed, then the time", async () => {
    const v = await venue("Offers")
    const p = await adult("rv_offer")
    const offer = await db.venue_offers.create({
      data: { venue_id: v, org_id: orgId, text: "A free coffee", audience_size: 5, ends_at: new Date(Date.now() + DAY) },
    })
    const send = await db.venue_offer_sends.create({ data: { offer_id: offer.id, venue_id: v, user_id: p.id } })
    expect((await myOffers(p.id))[0]).toMatchObject({ id: offer.id, state: "live", redeemedAt: null })
    const at = new Date()
    await db.venue_offer_sends.update({ where: { id: send.id }, data: { opened_at: new Date(at.getTime() - 1000), redeemed_at: at, redeemed_night: new Date(at.toISOString().slice(0, 10)) } })
    expect((await myOffers(p.id))[0]).toMatchObject({ state: "redeemed", redeemedAt: at.toISOString() })
  })
})
