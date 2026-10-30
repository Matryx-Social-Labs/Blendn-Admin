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

import { randomUUID } from "crypto"
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
const upcomingRoute = require("@/app/api/mobile/venues/[venueId]/upcoming/route") as typeof import("@/app/api/mobile/venues/[venueId]/upcoming/route")
const regular = require("@/app/api/mobile/venues/[venueId]/regular/route") as typeof import("@/app/api/mobile/venues/[venueId]/regular/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const DAY = 86_400_000
const HOUR = 3_600_000
const TOKEN = `zrv${Date.now().toString(36).replace(/\d/g, "")}q`

const users: string[] = []
const venues: string[] = []
const events: string[] = []
const amenityIds: string[] = []
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
  await db.venue_amenities.deleteMany({ where: { venue_id: { in: venues } } })
  await db.amenities.deleteMany({ where: { id: { in: amenityIds } } })
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
    const full = await venue("Full", { capacity: 80, hours, description: "A rooftop." })
    const [first, second, retired] = await Promise.all(
      [["Zed Outdoor", 2, true], ["Zed Music", 1, true], ["Zed Retired", 0, false]].map(([name, sort_order, is_active]) =>
        db.amenities.create({ data: { name: name as string, slug: testId("am"), sort_order: sort_order as number, is_active: is_active as boolean } })
      )
    )
    amenityIds.push(first.id, second.id, retired.id)
    await db.venue_amenities.createMany({ data: [first, second, retired].map((a) => ({ venue_id: full, amenity_id: a.id })) })
    const bare = await venue("Bare")
    const garbled = await venue("Garbled", { hours: { monday: "late" } })

    const a = await body(await get(detail, `/api/mobile/venues/${full}`, viewer, { venueId: full }))
    expect(a.data.venue).toMatchObject({ capacity: 80, dayResetHour: 6, hours, description: "A rooftop.", upcoming: [] })
    // The day's reset hour and the zone it is read in, as the venue has them: not the default, so a hard-coded 6 / UTC fails.
    const kolkata = await venue("Kolkata", { timezone: "Asia/Kolkata", day_reset_hour: 4 })
    const k = await body(await get(detail, `/api/mobile/venues/${kolkata}`, viewer, { venueId: kolkata }))
    expect(k.data.venue).toMatchObject({ dayResetHour: 4, timezone: "Asia/Kolkata" })
    expect(a.data.venue).toMatchObject({ dayResetHour: 6, timezone: "UTC" })
    // The shared vocabulary, in its display order, without a retired amenity.
    expect(a.data.venue.amenities).toEqual(["Zed Music", "Zed Outdoor"])
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
    // A venue day that every other filter would let through: the database refuses a public venue
    // day (`events_venue_day_shape`), so lift the CHECK for this row only and put it back. Only
    // `...realEventsWhere` keeps it off the page.
    const day = (await venueDayFor(v))!
    events.push(day.id)
    await db.$executeRawUnsafe(`ALTER TABLE events DROP CONSTRAINT events_venue_day_shape`)
    try {
      await db.events.update({
        where: { id: day.id },
        data: { visibility: "public", status: "published", start_time: new Date(Date.now() + 2 * HOUR), end_time: new Date(Date.now() + 20 * HOUR) },
      })
      const res = await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))
      expect(res.data.venue.upcoming.map((e: { id: string }) => e.id)).toEqual([sooner, control, later])
      const card = (await body(await get(list, `/api/mobile/venues?search=${TOKEN}%20Upcoming`))).data.venues[0]
      expect(card.upcomingEventCount).toBe(3)
      expect(card.nextEvent.id).toBe(sooner)
    } finally {
      await db.events.update({ where: { id: day.id }, data: { visibility: "unlisted" } })
      await db.$executeRawUnsafe(
        `ALTER TABLE events ADD CONSTRAINT events_venue_day_shape CHECK ("kind" = 'event' OR ("venue_id" IS NOT NULL AND "visibility" = 'unlisted' AND "organizer_org_id" IS NULL))`
      )
    }
    const res = await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))
    expect(res.data.venue.upcoming.map((e: { id: string }) => e.id)).toEqual([sooner, control, later])
    expect(res.data.venue.upcoming[0]).toEqual({
      id: sooner,
      title: expect.any(String),
      slug: expect.any(String),
      coverImageUrl: null,
      startTime: expect.any(String),
      endTime: expect.any(String),
      // The event's own zone (`eventAt` leaves the fixture's UTC), so the app formats `startTime` where it is.
      timezone: "UTC",
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
    // And says there are seven, and where the other two are.
    expect(res.data.venue.upcomingTotal).toBe(7)
    expect(res.data.venue.upcomingNextCursor).toEqual(expect.any(String))
  })

  it("`upcomingTotal` and the cursor are the whole list's, and the cursor walks to the end through events sharing a start", async () => {
    const v = await venue("Walk")
    const same = new Date(Date.now() + 6 * HOUR)
    const ids: string[] = []
    // 14 events: 6 share one start, the rest follow; soonest first, id as the tiebreak.
    for (let i = 0; i < 14; i++) {
      ids.push(await eventAt(v, 6 + (i < 6 ? 0 : i), i < 6 ? { start_time: same, end_time: new Date(same.getTime() + 2 * HOUR) } : {}))
    }
    const expected = (
      await db.events.findMany({ where: { id: { in: ids } }, orderBy: [{ start_time: "asc" }, { id: "asc" }], select: { id: true } })
    ).map((e) => e.id)

    const first = await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))
    expect(first.data.venue.upcoming.map((e: { id: string }) => e.id)).toEqual(expected.slice(0, 5))
    expect(first.data.venue.upcomingTotal).toBe(14)

    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const q: string = `limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      const page = await body(await get(upcomingRoute, `/api/mobile/venues/${v}/upcoming?${q}`, viewer, { venueId: v }))
      expect(page.status).toBe(200)
      expect(page.data.pagination.totalCount).toBe(14)
      seen.push(...page.data.events.map((e: { id: string }) => e.id))
      if (!page.data.pagination.hasMore) break
      cursor = page.data.pagination.nextCursor
    }
    expect(seen).toEqual(expected)
  })

  it("the full list is the same filter: a private event, a disputed link and an age-gated one are not in it or its total", async () => {
    const v = await venue("Same")
    const shown = await eventAt(v, 5)
    await eventAt(v, 6, { visibility: "private" })
    await eventAt(v, 7, { venue_link_status: "disputed" })
    await eventAt(v, 8, { min_age: 40 })
    const page = await body(await get(upcomingRoute, `/api/mobile/venues/${v}/upcoming`, viewer, { venueId: v }))
    expect(page.data.events.map((e: { id: string }) => e.id)).toEqual([shown])
    expect(page.data.pagination).toEqual({ limit: 20, hasMore: false, nextCursor: null, totalCount: 1 })
    expect((await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))).data.venue.upcomingTotal).toBe(1)
  })

  it("the full list refuses a cursor that is not ours, an unknown venue, and caps limit", async () => {
    const v = await venue("Refuse")
    for (let i = 1; i <= 3; i++) await eventAt(v, i * 2)
    expect((await body(await get(upcomingRoute, `/api/mobile/venues/${v}/upcoming?cursor=nope`, viewer, { venueId: v }))).status).toBe(400)
    expect((await body(await get(upcomingRoute, `/api/mobile/venues/${randomUUID()}/upcoming`, viewer, { venueId: randomUUID() }))).status).toBe(404)
    expect((await body(await get(upcomingRoute, `/api/mobile/venues/${v}/upcoming?limit=1000`, viewer, { venueId: v }))).data.pagination.limit).toBe(100)
  })

  it("a venue with nothing coming answers an empty list and a total of 0", async () => {
    const v = await venue("Empty")
    const d = await body(await get(detail, `/api/mobile/venues/${v}`, viewer, { venueId: v }))
    expect(d.data.venue).toMatchObject({ upcoming: [], upcomingTotal: 0, upcomingNextCursor: null })
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

describe("GET /venues?order=live, three tiers", () => {
  it("returns live, then open tonight, then the rest, in order across two pages, and echoes pagination.order", async () => {
    const live = await venue("zt D live")
    const byHours = await venue("zt C hours", { hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "10:00", close: "23:00" })) })
    const byEvent = await venue("zt B event")
    // Tonight is the venue's day, which ends at its reset hour: "3 h ahead" is past it for the three hours before 06:00 UTC. Start halfway to the day's end, so it is inside at any hour.
    await eventAt(byEvent, (venueDayBounds("UTC", 6, new Date()).end.getTime() - Date.now()) / 2 / HOUR)
    const rest1 = await venue("zt A rest")
    const rest2 = await venue("zt E rest")
    // A later event is not tonight; hours on no day are not tonight either.
    const farEvent = await venue("zt F far")
    await eventAt(farEvent, 30)
    const day = (await venueDayFor(live))!
    events.push(day.id)
    const occ = await occurrenceOf(day.id)
    for (let i = 0; i < 5; i++) {
      const p = await adult(`rv_t${i}`)
      await db.event_check_ins.create({
        data: { event_id: day.id, occurrence_id: occ, user_id: p.id, kind: "attendee", status: "checked_in", expires_at: new Date(Date.now() + HOUR) },
      })
    }
    const page = async (n: number) => {
      const res = await body(await get(list, `/api/mobile/venues?search=${TOKEN}%20zt&order=live&limit=3&page=${n}`))
      return res.data
    }
    const [one, two] = [await page(1), await page(2)]
    const ids = (d: { venues: { id: string }[] }) => d.venues.map((v) => v.id)
    // live; then open tonight (by event "B", by hours "C", name order); then the rest by name.
    expect(ids(one)).toEqual([live, byEvent, byHours])
    expect(ids(two)).toEqual([rest1, rest2, farEvent])
    // Every item names its tier, and the tiers read down both pages in the order they were ranked.
    const tiers = [...one.venues, ...two.venues].map((v: { tier: string }) => v.tier)
    expect(tiers).toEqual(["live", "open", "open", "quiet", "quiet", "quiet"])
    // The same rule without the order: each venue's own tier, whatever the sort.
    const plainTiers = (await body(await get(list, `/api/mobile/venues?search=${TOKEN}%20zt&limit=6`))).data.venues
    expect(Object.fromEntries(plainTiers.map((v: { id: string; tier: string }) => [v.id, v.tier]))).toEqual({
      [live]: "live",
      [byEvent]: "open",
      [byHours]: "open",
      [rest1]: "quiet",
      [rest2]: "quiet",
      [farEvent]: "quiet",
    })
    expect(one.pagination.order).toBe("live")
    expect(two.pagination.order).toBe("live")
    // Without the order there is no meta, and the plain name order stands.
    const plain = (await body(await get(list, `/api/mobile/venues?search=${TOKEN}%20zt&limit=6`))).data
    expect(plain.pagination.order).toBeUndefined()
    expect(ids(plain)).toEqual([rest1, byEvent, byHours, live, rest2, farEvent])
    // By distance the tiers hold too.
    const dist = (await body(await get(list, `/api/mobile/venues?search=${TOKEN}%20zt&order=live&sortBy=distance&lat=12.97&lon=77.59&limit=3`))).data
    expect(ids(dist)[0]).toBe(live)
    expect(new Set(ids(dist).slice(1))).toEqual(new Set([byEvent, byHours]))
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
