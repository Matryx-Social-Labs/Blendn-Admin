process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { venueDayFor } from "@/lib/venue-day"

import { closeDb, db, makeUser, testId } from "./helpers"
import { cleanupWorld, person, realEvent, req, venue, world } from "./go-live-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
const summaryRoute = require("@/app/api/mobile/venues/summary/route") as typeof import("@/app/api/mobile/venues/summary/route")
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * The home panes' server fields (C1, C4–C7) against real Postgres: the
 * featured section, the area on a venue and its filter, tonight's hours, the
 * multi-type filter, and the summary that counts the very venues the list
 * lists. Every fixture is in one throwaway city, so the counts are exact.
 */

const CITY = testId("hpcity")
const HOUR = 3_600_000
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "18:00", close: "01:00" }))

let viewer = { id: "", token: "" }
let ids = { pub: "", brewery: "", cafe: "", noArea: "", takenOver: "", live: "" }

/** A venue in the suite's city, with the area, type and hours a test chooses. */
async function place(label: string, data: { venue_type: "pub_bar" | "brewery" | "cafe"; area?: [string, string]; hours?: unknown }) {
  const id = await venue()
  await db.venues.update({
    where: { id },
    data: {
      name: `${CITY} ${label}`,
      city: CITY,
      venue_type: data.venue_type,
      ...(data.area && { area: data.area[0], area_slug: data.area[1] }),
      ...(data.hours !== undefined && { hours: data.hours as object }),
    },
  })
  return id
}

const get = async (route: { GET: (r: never) => Promise<Response> }, url: string, token = viewer.token) => {
  const res = await route.GET(req(url, token) as never)
  return { status: res.status, body: await res.json() }
}
const listed = async (query: string) => {
  const { status, body } = await get(venuesRoute, `/api/mobile/venues?city=${CITY}&limit=100&${query}`)
  expect(status).toBe(200)
  return body.data as { venues: { id: string; area: string | null; areaSlug: string | null; tonight: unknown }[]; pagination: { totalCount: number } }
}
const idsOf = (d: { venues: { id: string }[] }) => d.venues.map((v) => v.id).sort()

beforeAll(async () => {
  viewer = await person("hp_viewer")
  ids = {
    pub: await place("pub", { venue_type: "pub_bar", area: ["Indiranagar", "indiranagar"], hours: EVERY_DAY }),
    brewery: await place("brewery", { venue_type: "brewery", area: ["Indiranagar", "indiranagar"] }),
    cafe: await place("cafe", { venue_type: "cafe", area: ["HSR Layout", "hsr-layout"] }),
    noArea: await place("no area", { venue_type: "pub_bar" }),
    takenOver: await place("taken over", { venue_type: "pub_bar", area: ["Indiranagar", "indiranagar"] }),
    live: await place("live", { venue_type: "cafe", area: ["HSR Layout", "hsr-layout"] }),
  }
  // An event running at one venue has taken it over: Places leaves it out.
  await realEvent(ids.takenOver, { startsInMin: -10, link: "confirmed" })
  // Five other guests live at another: a bucket, so the venue counts as live.
  const day = await venueDayFor(ids.live)
  for (let i = 0; i < 5; i++) {
    const guest = await makeUser(testId("hp_guest"))
    world.users.push(guest)
    await db.event_check_ins.create({
      data: {
        event_id: day!.id,
        occurrence_id: day!.occurrenceId,
        user_id: guest,
        status: "checked_in",
        check_in_time: new Date(),
        expires_at: new Date(Date.now() + HOUR),
      },
    })
  }
})

afterAll(async () => {
  await cleanupWorld()
  await closeDb()
}, 120_000)

describe("C7: the kind filter takes a list", () => {
  it("returns a venue of any of the types, and none of the others", async () => {
    const both = await listed("venueType=pub_bar,brewery")
    expect(idsOf(both)).toEqual([ids.pub, ids.brewery, ids.noArea].sort())
    const alias = await listed("venueTypes=brewery,cafe")
    expect(idsOf(alias)).toEqual([ids.brewery, ids.cafe, ids.live].sort())
  })

  it("is a 400 for an unknown type", async () => {
    const { status } = await get(venuesRoute, `/api/mobile/venues?city=${CITY}&venueType=pub_bar,speakeasy`)
    expect(status).toBe(400)
  })
})

describe("C4: area", () => {
  it("filters by slug, and a venue with no area is in none", async () => {
    const indiranagar = await listed("area=indiranagar")
    // The taken-over venue is in the area but not listed: the list's own rule.
    expect(idsOf(indiranagar)).toEqual([ids.pub, ids.brewery].sort())
    expect(indiranagar.venues.every((v) => v.area === "Indiranagar" && v.areaSlug === "indiranagar")).toBe(true)
    expect(idsOf(await listed("area=nowhere"))).toEqual([])
  })

  it("says null for both when the area is unknown, never a guess", async () => {
    const all = await listed("")
    const none = all.venues.find((v) => v.id === ids.noArea)
    expect(none).toMatchObject({ area: null, areaSlug: null })
  })
})

describe("C6: tonight's hours", () => {
  it("comes from venues.hours, and is null where none were given", async () => {
    const all = await listed("")
    const by = (id: string) => all.venues.find((v) => v.id === id)
    expect(by(ids.pub)?.tonight).toEqual({ opensAt: "18:00", closesAt: "01:00" })
    expect(by(ids.brewery)?.tonight).toBeNull()
  })
})

describe("C5: the summary", () => {
  it("counts exactly the venues the list lists, split by type and by area", async () => {
    const list = await listed("")
    const { status, body } = await get(summaryRoute, `/api/mobile/venues/summary?city=${CITY}`)
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    const s = body.data
    // Five of the six: the taken-over venue is in neither.
    expect(list.pagination.totalCount).toBe(5)
    expect(s.total).toBe(list.pagination.totalCount)
    expect(s.types).toEqual([
      { venueType: "cafe", label: "Café", count: 2 },
      { venueType: "pub_bar", label: "Pub or bar", count: 2 },
      { venueType: "brewery", label: "Brewery", count: 1 },
    ])
    expect(s.areas).toEqual([
      // Live first: the cafe with five guests live.
      { slug: "hsr-layout", name: "HSR Layout", count: 2, liveCount: 1, typeMix: ["cafe"] },
      { slug: "indiranagar", name: "Indiranagar", count: 2, liveCount: 0, typeMix: ["brewery", "pub_bar"] },
    ])
    expect(s.liveCount).toBe(1)
    // The pub has hours for every day; the live venue is not also counted open.
    expect(s.openTonightCount).toBe(1)
  })

  it("answers the same total as the list for a city nobody has", async () => {
    const { body } = await get(summaryRoute, `/api/mobile/venues/summary?city=${CITY}-elsewhere`)
    expect(body.data).toEqual({ total: 0, liveCount: 0, openTonightCount: 0, types: [], areas: [] })
  })
})

describe("C1: featured", () => {
  const eventIds: string[] = []
  let ended = ""
  let unfeatured = ""
  let adultsOnly = ""

  /** A real event in the suite's city, at a venue the city list does not read. */
  async function featuredEvent(venueId: string, startsInMin: number, data: { is_featured: boolean; minAge?: number; hours?: number }) {
    const id = await realEvent(venueId, { startsInMin, minAge: data.minAge, hours: data.hours })
    await db.events.update({ where: { id }, data: { city: CITY, is_featured: data.is_featured } })
    eventIds.push(id)
    return id
  }

  beforeAll(async () => {
    const host = await venue()
    const day = 24 * 60
    for (let i = 0; i < 6; i++) await featuredEvent(host, (2 + i) * day, { is_featured: true })
    adultsOnly = await featuredEvent(host, 2 * day - 30, { is_featured: true, minAge: 18 })
    unfeatured = await featuredEvent(host, 3 * day + 30, { is_featured: false })
    ended = await featuredEvent(host, -600, { is_featured: true, hours: 3 })
  })

  const featuredList = async (query: string, token = viewer.token) => {
    const { status, body } = await get(eventsRoute, `/api/mobile/events?city=${CITY}&${query}`, token)
    expect(status).toBe(200)
    return body.data as {
      events: { id: string; isFeatured: boolean; startTime: string; featured: { kind: string; rank: number; by: string } | null }[]
      pagination: { totalCount: number; limit: number }
    }
  }

  it("returns at most five, in start order, each with its rank, and never an unfeatured, ended or too-young event", async () => {
    const { events, pagination } = await featuredList("featured=true&limit=50")
    expect(events).toHaveLength(5)
    expect(pagination).toMatchObject({ totalCount: 5, limit: 5 })
    expect(events.map((e) => e.featured?.rank)).toEqual([1, 2, 3, 4, 5])
    expect(events.every((e) => e.featured?.kind === "editorial" && e.featured.by === "blendn" && e.isFeatured)).toBe(true)
    const starts = events.map((e) => Date.parse(e.startTime))
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    const returned = events.map((e) => e.id)
    expect(returned).not.toContain(unfeatured)
    expect(returned).not.toContain(ended)
    // An adult (30) may see the 18+ night; it is the earliest, so it is rank 1.
    expect(returned[0]).toBe(adultsOnly)
  })

  it("keeps the age gate: a 17-year-old's five do not include the 18+ night", async () => {
    const teen = await person("hp_teen", { age: 17 })
    const { events } = await featuredList("featured=true", teen.token)
    expect(events.map((e) => e.id)).not.toContain(adultsOnly)
    expect(events).toHaveLength(5)
  })

  it("does not bring an ended event back with includePast", async () => {
    const { events } = await featuredList("featured=true&includePast=true")
    expect(events.map((e) => e.id)).not.toContain(ended)
  })

  it("without the filter, is on every item: null for an unfeatured event, a rank for the rest", async () => {
    const { events } = await featuredList("limit=50")
    const byId = new Map(events.map((e) => [e.id, e]))
    expect(byId.get(unfeatured)?.featured).toBeNull()
    expect(byId.get(unfeatured)?.isFeatured).toBe(false)
    expect(byId.get(adultsOnly)?.featured).toMatchObject({ kind: "editorial", rank: 1 })
    expect(events.filter((e) => e.featured).map((e) => e.featured?.rank)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})
