jest.mock("@/lib/db", () => ({ db: {}, closeDb: jest.fn() }))

import { cityMatchFor, localSlug, localiseText, placeVenues, seededEventsWhere, slugPrefix, wallClock, zoneDisagreement, type SeedCity } from "../scripts/seed-city"
import { EVENTS, VENUES, forCity } from "../scripts/seed-blr-scenarios"

/*
 * The scenario seed for any catalogue city (scripts/seed-city.ts). Bengaluru is
 * the seed it always was; another city gets the same scenarios in its own zone,
 * inside its own box, under its own slug prefix, and never touches Bengaluru.
 */

const city = (over: Partial<SeedCity>): SeedCity => ({
  slug: "bengaluru",
  name: "Bengaluru",
  state: "Karnataka",
  country: "India",
  timezone: "Asia/Kolkata",
  centre: { latitude: 12.9716, longitude: 77.5946 },
  bounds: { minLat: 12.83, minLon: 77.45, maxLat: 13.14, maxLon: 77.78 },
  matchKeys: ["bangalore", "bengaluru", "bengaluru urban"],
  licensedMinAge: null,
  ...over,
})

const BENGALURU = city({})
const TORONTO = city({
  slug: "toronto",
  name: "Toronto",
  state: "ON",
  country: "Canada",
  timezone: "America/Toronto",
  centre: { latitude: 43.6532, longitude: -79.3832 },
  bounds: { minLat: 43.58, minLon: -79.64, maxLat: 43.86, maxLon: -79.11 },
  matchKeys: ["brampton", "east york", "etobicoke", "markham", "mississauga", "north york", "richmond hill", "scarborough", "toronto", "vaughan"],
  licensedMinAge: 19,
})
const VANCOUVER = city({
  slug: "vancouver",
  name: "Vancouver",
  state: "BC",
  country: "Canada",
  timezone: "America/Vancouver",
  centre: { latitude: 49.2827, longitude: -123.1207 },
  bounds: { minLat: 49.2, minLon: -123.27, maxLat: 49.32, maxLon: -123.02 },
  matchKeys: ["burnaby", "coquitlam", "new westminster", "north vancouver", "vancouver", "west vancouver"],
  licensedMinAge: 19,
})

describe("wallClock", () => {
  it("gives Bengaluru exactly what the old +05:30 helper gave", () => {
    const now = new Date("2026-11-01T21:47:00Z") // 03:17 on 2 Nov in Bengaluru
    const old = (day: number, hhmm: string) => new Date(new Date(`2026-11-02T${hhmm}:00+05:30`).getTime() + day * 24 * 3_600_000)
    for (const [day, hhmm] of [[0, "20:30"], [6, "12:00"], [-3, "04:30"], [1, "08:30"], [4, "22:00"], [13, "21:00"]] as const) {
      expect(wallClock("Asia/Kolkata", now, day, hhmm)).toEqual(old(day, hhmm))
    }
  })

  it("follows Toronto's clock across the end of daylight saving (1 Nov 2026)", () => {
    const now = new Date("2026-10-31T16:00:00Z") // noon on 31 Oct in Toronto, EDT
    expect(wallClock("America/Toronto", now, 0, "20:30").toISOString()).toBe("2026-11-01T00:30:00.000Z")
    expect(wallClock("America/Toronto", now, 2, "20:30").toISOString()).toBe("2026-11-03T01:30:00.000Z")
  })

  it("reads 'today' in the city's zone, not the machine's", () => {
    const now = new Date("2026-11-01T02:00:00Z") // still 31 Oct in Vancouver
    expect(wallClock("America/Vancouver", now, 0, "09:00").toISOString()).toBe("2026-10-31T16:00:00.000Z")
  })
})

describe("slugs", () => {
  it("keeps blr- for Bengaluru and uses the city slug elsewhere", () => {
    expect(slugPrefix(BENGALURU)).toBe("blr-")
    expect(localSlug(BENGALURU, "blr-evening-ragas")).toBe("blr-evening-ragas")
    expect(slugPrefix(TORONTO)).toBe("toronto-")
    expect(localSlug(TORONTO, "blr-evening-ragas")).toBe("toronto-evening-ragas")
    expect(() => localSlug(TORONTO, "evening-ragas")).toThrow()
  })

  it("--clean takes only the city's own prefix", () => {
    expect(seededEventsWhere(TORONTO)).toEqual({ slug: { startsWith: "toronto-" }, deleted_at: null })
  })
})

describe("cityMatchFor — what the remove step may soft-delete", () => {
  it("is Bengaluru's old match, unchanged", () => {
    expect(cityMatchFor(BENGALURU)).toEqual({
      OR: [
        { city: { equals: "Bengaluru", mode: "insensitive" } },
        { city: { equals: "Bangalore", mode: "insensitive" } },
        { AND: [{ city: null }, { OR: [{ address: { contains: "Bengaluru", mode: "insensitive" } }, { address: { contains: "Bangalore", mode: "insensitive" } }] }] },
      ],
    })
  })

  it("names only Toronto's catalogue names for Toronto", () => {
    const text = JSON.stringify(cityMatchFor(TORONTO)).toLowerCase()
    expect(text).not.toMatch(/bengaluru|bangalore|vancouver/)
    for (const key of TORONTO.matchKeys) expect(text).toContain(`"equals":"${key}"`)
    expect(text).toContain(`{"city":null},{"address":{"contains":"toronto"`)
  })
})

describe("placeVenues", () => {
  it("returns Bengaluru's venues as they are", () => {
    expect(placeVenues(VENUES, BENGALURU)).toBe(VENUES)
  })

  it.each([TORONTO, VANCOUVER])("puts every venue and fence inside $name's box, under a neutral name", (c) => {
    const placed = Object.values(placeVenues(VENUES, c))
    const inside = (lat: number, lng: number) =>
      lat > c.bounds.minLat && lat < c.bounds.maxLat && lng > c.bounds.minLon && lng < c.bounds.maxLon
    expect(placed).toHaveLength(Object.keys(VENUES).length)
    expect(new Set(placed.map((v) => v.name)).size).toBe(placed.length)
    for (const v of placed) {
      expect(inside(v.lat, v.lng)).toBe(true)
      const points = v.fence.type === "circle" ? [[v.fence.lat, v.fence.lng]] : v.fence.ring
      for (const [lat, lng] of points) expect(inside(lat, lng)).toBe(true)
      expect(v.name).toMatch(/ \(test\)$/)
      expect(v.address).toMatch(new RegExp(`^\\d+ [A-Z][\\w ]+, ${c.name}$`))
      expect(v.postal).toBe("")
    }
  })
})

/** What a Canadian tester must never read on a seeded event. */
const INDIA = /₹|Bengaluru|Bangalore|Karnataka|Kannada|\bIndia\b|BMTC|BBMP|Namma|\bIMD\b|\bUPI\b|lakh|Koramangala|Indiranagar|Hebbal|Malleshwaram|Nandi|Cubbon|darshini|dosa|Olive Beach|Third Wave|BFlat|Blue Tokai|Lupa|Kitty Ko|Atta Galatta|Dialogues|Chowdiah|Jayamahal|Lalit|Grover|Kantara|\bHSR\b|Sante|Byg|Arbor|NIMHANS|WeWork|Decathlon|\bBIC\b|Airlines Hotel|MG Road|\.in\b/

describe("forCity", () => {
  it("is the identity for Bengaluru", () => {
    for (const e of EVENTS) expect(forCity(e, BENGALURU)).toBe(e)
  })

  it.each([TORONTO, VANCOUVER])("leaves nothing that reads as India on $name's events", (c) => {
    for (const e of EVENTS) {
      const local = forCity(e, c)
      // `venue` is the spec's key into VENUES (`decathlonHebbal`), never shown.
      const { when: _when, venue: _venue, ...data } = local
      void _when
      void _venue
      expect({ slug: local.slug, text: JSON.stringify(data).match(INDIA)?.[0] ?? null }).toEqual({ slug: local.slug, text: null })
      expect(local.slug.startsWith(`${c.slug}-`)).toBe(true)
    }
    for (const v of Object.values(placeVenues(VENUES, c))) expect(`${v.name} ${v.address}`).not.toMatch(INDIA)
  })

  it("seats no named QA person in another city's rooms, so Bengaluru's check-ins are never moved", () => {
    const seated = EVENTS.map((e) => forCity(e, TORONTO)).filter((e) => e.social?.checkedIn?.length)
    expect(seated).toEqual([])
    expect(EVENTS.some((e) => e.social?.checkedIn?.length)).toBe(true)
  })

  it("makes a 21+ licensed scenario the city's licensed age where it has one", () => {
    const techno = EVENTS.find((e) => e.slug === "blr-techno-warehouse")!
    expect(forCity(techno, TORONTO).minAge).toBe(19)
    expect(forCity(techno, city({ slug: "mumbai", name: "Mumbai" })).minAge).toBe(21)
    expect(localiseText("21+ with ID", TORONTO)).toBe("19+ with ID")
  })
})

describe("zoneDisagreement: the seed's clock and the database's must agree before anything is written", () => {
  const at = new Date("2026-11-15T12:00:00Z")
  const dbSaying = (minutes: number) => ({ $queryRaw: (async () => [{ minutes }]) as never })

  it("passes when the database gives the offset this process gives", async () => {
    const mine = -Number(/GMT-(\d{2})/.exec(new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", timeZoneName: "longOffset" }).format(at))![1]) * 60
    expect(await zoneDisagreement(dbSaying(mine), "America/Toronto", [at])).toBeNull()
  })

  it("refuses, naming both offsets, when they differ (Vancouver on 2026-11-01: UTC-7 against a stale UTC-8)", async () => {
    const message = await zoneDisagreement(dbSaying(-11 * 60), "America/Toronto", [at])
    expect(message).toMatch(/^America\/Toronto on 2026-11-15: this Node \(tzdata .+\) says UTC-5, the database says UTC-11\./)
  })
})
