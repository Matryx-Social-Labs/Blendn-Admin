import { NextRequest } from "next/server"

import { db, closeDb, makeUser, testId, cleanup } from "./helpers"

/**
 * The public share read the landing's pages and cards are drawn from (Flow 16),
 * against real Postgres. What it has to hold:
 *
 *   - every reason an event cannot be read is ONE response, status, body and
 *     headers: private, draft, deleted, suspended host, venue day, an id nobody
 *     made, an id that is not a UUID, a venue that is gone;
 *   - a venue's list of what is coming is public events only;
 *   - an unlisted event is readable and says the area and nothing finer;
 *   - one fixed rate-limit key per network, so a forged header buys nothing.
 */

const SECRET = "share-itest-secret-0123456789abcdef0123456789"
process.env.SHARE_PROXY_SECRET = SECRET

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/public/share/events/[eventId]/route") as typeof import("@/app/api/public/share/events/[eventId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const venueRoute = require("@/app/api/public/share/venues/[venueId]/route") as typeof import("@/app/api/public/share/venues/[venueId]/route")

const HOUR = 3_600_000
const AREA = "Indiranagar"
const VENUE_NAME = `Toit${Math.random().toString(36).slice(2, 8)}`
const VENUE_FENCE = { type: "circle", lat: 12.97, lng: 77.64, radius: 100, buffer: 50 }
const UNKNOWN = "5b2c1d3e-0000-4000-8000-00000000dead"

let user: string
let suspendedHost: string
let goneHost: string
let suspendedOrg: string
let venue: string
let archivedVenue: string
let optedOutVenue: string
let claimOrg: string
const events: Record<string, string> = {}
const ips = new Set<string>()

/** A fresh client address per call, so a test never spends another's rate-limit budget. */
function freshIp() {
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
  ips.add(ip)
  return ip
}

function get(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, { headers: { "x-real-ip": freshIp(), ...headers } })
}

const readEvent = (id: string, headers?: Record<string, string>) =>
  eventRoute.GET(get(`/api/public/share/events/${id}`, headers), { params: Promise.resolve({ eventId: id }) })
const readVenue = (id: string, headers?: Record<string, string>) =>
  venueRoute.GET(get(`/api/public/share/venues/${id}`, headers), { params: Promise.resolve({ venueId: id }) })

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text(), headers: [...res.headers].sort() }
}

async function makeShareEvent(label: string, data: Record<string, unknown> = {}) {
  const now = Date.now()
  const slug = testId(`share_${label}`)
  const event = await db.events.create({
    data: {
      slug,
      title: `Share ${label}`,
      description: `Description of ${label}`,
      start_time: new Date(now + 2 * HOUR),
      end_time: new Date(now + 4 * HOUR),
      timezone: "Asia/Kolkata",
      status: "published",
      organizer_id: user,
      visibility: "public",
      venue_id: venue,
      venue_link_status: "confirmed",
      venue_name: VENUE_NAME,
      address: "100 Feet Road",
      city: "Bengaluru",
      ...data,
    } as never,
  })
  events[label] = event.id
  return event.id
}

beforeAll(async () => {
  user = await makeUser("share_org", "organizer")
  suspendedHost = await makeUser("share_susp", "organizer")
  goneHost = await makeUser("share_gone", "organizer")
  await db.user.update({ where: { id: suspendedHost }, data: { suspended_at: new Date(), suspension_reason: "itest" } })
  await db.user.update({ where: { id: goneHost }, data: { deletedAt: new Date() } })
  suspendedOrg = (await db.organisations.create({ data: { display_name: "Suspended Co", status: "suspended" } })).id
  claimOrg = (await db.organisations.create({ data: { display_name: "Claim Co", status: "verified" } })).id
  venue = (await db.venues.create({ data: { name: VENUE_NAME, area: AREA, area_slug: "indiranagar", city: "Bengaluru", venue_type: "pub_bar", geofence: VENUE_FENCE } })).id
  archivedVenue = (await db.venues.create({ data: { name: "Archived", status: "archived" } })).id
  optedOutVenue = (await db.venues.create({ data: { name: "Opted Out", owner_org_id: claimOrg, claimed_at: new Date(), open_on_blendn: false } })).id

  await makeShareEvent("public")
  await makeShareEvent("public2", { start_time: new Date(Date.now() + 6 * HOUR), end_time: new Date(Date.now() + 8 * HOUR) })
  await makeShareEvent("unlisted", { visibility: "unlisted" })
  await makeShareEvent("private", { visibility: "private" })
  await makeShareEvent("draft", { status: "draft" })
  await makeShareEvent("deleted", { deleted_at: new Date() })
  await makeShareEvent("suspended", { organizer_org_id: suspendedOrg })
  await makeShareEvent("cancelled", { status: "cancelled" })
  await makeShareEvent("completed", { status: "completed", start_time: new Date(Date.now() - 6 * HOUR), end_time: new Date(Date.now() - 4 * HOUR) })
  // Linked to the venue by somebody else, but located elsewhere: not at the venue.
  await makeShareEvent("elsewhere", { venue_link_status: "auto_linked", latitude: 13.5, longitude: 77.0, title: "Elsewhere" })
  // The same unconfirmed link, located at the venue: at the venue (the positive control).
  await makeShareEvent("nearby", { venue_link_status: "auto_linked", latitude: 12.97, longitude: 77.64, start_time: new Date(Date.now() + 10 * HOUR), end_time: new Date(Date.now() + 12 * HOUR) })
  // A suspended person's, and a deleted account's, still-published events.
  await makeShareEvent("suspendedHost", { organizer_id: suspendedHost })
  await makeShareEvent("goneHost", { organizer_id: goneHost })
  // An unlisted event whose cover key carries the venue's name (the uploader chooses the key).
  await makeShareEvent("unlistedCover", { visibility: "unlisted", cover_image_url: `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev/events/u1/${VENUE_NAME}-cover.jpg` })
  await makeShareEvent("day", { kind: "venue_day", visibility: "unlisted", organizer_id: "blendn-system" })
})

afterAll(async () => {
  await db.events.deleteMany({ where: { id: { in: Object.values(events) } } })
  await db.venues.deleteMany({ where: { id: { in: [venue, archivedVenue, optedOutVenue].filter(Boolean) } } })
  await db.user.deleteMany({ where: { id: { in: [suspendedHost, goneHost].filter(Boolean) } } })
  await db.organisations.deleteMany({ where: { id: { in: [suspendedOrg, claimOrg].filter(Boolean) } } })
  await cleanup([user], [])
  await closeDb()
})

describe("GET /api/public/share/events/:eventId", () => {
  it("answers every unreadable id with the same status, body and headers", async () => {
    const unreadable = ["private", "draft", "deleted", "suspended", "suspendedHost", "goneHost", "day"].map((l) => events[l])
    const answers = await Promise.all([...unreadable, UNKNOWN, "not-a-uuid", "../../etc/passwd"].map(async (id) => snapshot(await readEvent(id))))
    for (const answer of answers) {
      expect(answer.status).toBe(404)
      expect(answer).toEqual(answers[0])
    }
    expect(JSON.parse(answers[0].body)).toEqual({ available: false })
    expect(answers[0].headers).toContainEqual(["cache-control", "public, s-maxage=60, stale-while-revalidate=60"])
  })

  it("answers a gone venue the same way as a gone event", async () => {
    const event = await snapshot(await readEvent(UNKNOWN))
    for (const id of [UNKNOWN, "not-a-uuid", archivedVenue]) {
      expect(await snapshot(await readVenue(id))).toEqual(event)
    }
  })

  it("reads a public event with its place and the venue's other public events", async () => {
    const res = await readEvent(events.public)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=60")
    const { available, event } = await res.json()
    expect(available).toBe(true)
    expect(event).toMatchObject({
      id: events.public,
      state: "upcoming",
      indexable: true,
      place: { venue: { id: venue, name: VENUE_NAME }, name: VENUE_NAME, area: AREA },
      coverUrl: null,
    })
    expect(event.venueUpcoming.map((e: { id: string }) => e.id)).toEqual([events.public2, events.nearby])
  })

  it("never lists an unlisted, private or draft event as another event at the venue", async () => {
    const { event } = await (await readEvent(events.public)).json()
    const ids = event.venueUpcoming.map((e: { id: string }) => e.id)
    for (const label of ["unlisted", "private", "draft", "deleted", "suspended", "suspendedHost", "goneHost", "elsewhere", "day"]) expect(ids).not.toContain(events[label])
  })

  it("reads an unlisted event as area only, never the venue, address or description, and not indexable", async () => {
    const res = await readEvent(events.unlisted)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(VENUE_NAME)
    expect(text).not.toContain("100 Feet Road")
    expect(text).not.toContain("Description of unlisted")
    const { event } = JSON.parse(text)
    expect(event.indexable).toBe(false)
    expect(event.place).toEqual({ venue: null, name: null, address: null, area: AREA })
    expect(event.venueUpcoming).toEqual([])
  })

  it("never carries an unlisted event's cover, whose key can say the venue's name", async () => {
    const text = await (await readEvent(events.unlistedCover)).text()
    expect(text).not.toContain(VENUE_NAME)
    expect(JSON.parse(text).event.coverUrl).toBeNull()
  })

  it("says cancelled and ended, and keeps an ended public event indexable", async () => {
    expect((await (await readEvent(events.cancelled)).json()).event.state).toBe("cancelled")
    const ended = (await (await readEvent(events.completed)).json()).event
    expect(ended.state).toBe("ended")
    expect(ended.indexable).toBe(true)
  })

  it("serves a cover only from events/ on the public bucket", async () => {
    const host = `${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev`
    await db.events.update({ where: { id: events.public }, data: { cover_image_url: `https://${host}/events/u1/c.jpg` } })
    expect((await (await readEvent(events.public)).json()).event.coverUrl).toBe(`https://${host}/events/u1/c.jpg`)
    for (const bad of ["https://evil.example/events/u1/c.jpg", `https://${host}/profile/u1/c.jpg`, "http://169.254.169.254/events/x.jpg"]) {
      await db.events.update({ where: { id: events.public }, data: { cover_image_url: bad } })
      expect((await (await readEvent(events.public)).json()).event.coverUrl).toBeNull()
    }
  })
})

describe("GET /api/public/share/venues/:venueId", () => {
  it("lists public, published, future events only, never unlisted or private ones", async () => {
    const res = await readVenue(venue)
    expect(res.status).toBe(200)
    const { venue: body } = await res.json()
    expect(body).toMatchObject({ id: venue, name: VENUE_NAME, typeLabel: "Pub or bar", area: AREA, indexable: true })
    const ids = body.upcoming.map((e: { id: string }) => e.id)
    expect(ids).toEqual(expect.arrayContaining([events.public, events.public2, events.nearby]))
    for (const label of ["unlisted", "private", "draft", "deleted", "suspended", "suspendedHost", "goneHost", "elsewhere", "cancelled", "completed", "day"]) {
      expect(ids).not.toContain(events[label])
    }
  })

  it("is not indexable for a claimed venue that turned Open on Blendn off, and still answers", async () => {
    const res = await readVenue(optedOutVenue)
    expect(res.status).toBe(200)
    expect((await res.json()).venue.indexable).toBe(false)
  })
})

describe("the rate limit", () => {
  it("counts one network under one key across every path and refuses past 120, uncached", async () => {
    const ip = freshIp()
    const asLanding = { "x-share-proxy": SECRET, "x-share-client": ip, "x-real-ip": "10.0.0.1" }
    const statuses: number[] = []
    for (let i = 0; i < 121; i++) {
      const path = i % 2 ? `/api/public/share/venues/${UNKNOWN}` : `/api/public/share/events/${UNKNOWN}`
      const res = i % 2 ? await venueRoute.GET(get(path, asLanding), { params: Promise.resolve({ venueId: UNKNOWN }) }) : await eventRoute.GET(get(path, asLanding), { params: Promise.resolve({ eventId: UNKNOWN }) })
      statuses.push(res.status)
      if (res.status === 429) expect(res.headers.get("cache-control")).toBe("no-store")
    }
    expect(statuses.slice(0, 120).every((s) => s === 404)).toBe(true)
    expect(statuses[120]).toBe(429)
  })

  it("ignores a forged x-share-client: rotating it does not escape the real address's budget", async () => {
    const real = freshIp()
    let refused = 0
    for (let i = 0; i < 125; i++) {
      const res = await readEvent(UNKNOWN, { "x-real-ip": real, "x-share-client": `203.0.113.${i % 250}` })
      if (res.status === 429) refused++
    }
    expect(refused).toBe(5)
  })
})
