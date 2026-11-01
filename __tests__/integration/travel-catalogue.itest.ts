import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"

import { readShareEvent, readShareVenue } from "@/lib/share-public"

import { EventCitiesResponseSchema } from "@/lib/openapi/schemas/event"
import { ProfileResponseSchema } from "@/lib/openapi/schemas/profile"
import { cityKey } from "@/lib/address"

import { db, closeDb, makeUser, makeEvent, testId, occurrenceOf } from "./helpers"
import { clearCityPlaces } from "../support/city-places"
import { clearCityCatalogue } from "../support/city-catalogue"

/*
 * The catalogue against the seed M1 really wrote (a `migrate deploy` database):
 * Bengaluru with its alias, Toronto in preview. A hidden city is this file's own row.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
const summaryRoute = require("@/app/api/mobile/venues/summary/route") as typeof import("@/app/api/mobile/venues/summary/route")
const searchRoute = require("@/app/api/mobile/events/search/route") as typeof import("@/app/api/mobile/events/search/route")
const citiesRoute = require("@/app/api/mobile/events/cities/route") as typeof import("@/app/api/mobile/events/cities/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
const venueRoute = require("@/app/api/mobile/venues/[venueId]/route") as typeof import("@/app/api/mobile/venues/[venueId]/route")
const upcomingRoute = require("@/app/api/mobile/venues/[venueId]/upcoming/route") as typeof import("@/app/api/mobile/venues/[venueId]/upcoming/route")
const liveRoute = require("@/app/api/mobile/venues/[venueId]/live/route") as typeof import("@/app/api/mobile/venues/[venueId]/live/route")
const insideRoute = require("@/app/api/mobile/checkins/inside/route") as typeof import("@/app/api/mobile/checkins/inside/route")
const rsvpRoute = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
const favoriteRoute = require("@/app/api/mobile/events/[eventId]/favorite/route") as typeof import("@/app/api/mobile/events/[eventId]/favorite/route")
const interestRoute = require("@/app/api/mobile/events/[eventId]/interest/route") as typeof import("@/app/api/mobile/events/[eventId]/interest/route")
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const peopleRoute = require("@/app/api/mobile/events/[eventId]/people/route") as typeof import("@/app/api/mobile/events/[eventId]/people/route")
const crewsRoute = require("@/app/api/mobile/events/[eventId]/crews/route") as typeof import("@/app/api/mobile/events/[eventId]/crews/route")
const chatRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const matchesRoute = require("@/app/api/mobile/events/[eventId]/matches/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/route")
const pollRoute = require("@/app/api/mobile/events/[eventId]/polls/[pollId]/route") as typeof import("@/app/api/mobile/events/[eventId]/polls/[pollId]/route")
const regularRoute = require("@/app/api/mobile/venues/[venueId]/regular/route") as typeof import("@/app/api/mobile/venues/[venueId]/regular/route")
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const venues: string[] = []
const tag = testId("t").replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase()
const HIDDEN = `Qahidden${tag}`
const HIDDEN_SLUG = `qa-hidden-${tag}`
const HIDDEN_MARKET = "ZZ"
const IN_HIDDEN_MARKET = `Qahm${tag}`
// Unique words so full-text search finds only these rows.
const WORD = `zqword${tag}`
let plainUser: string
let previewer: string
let plain: string
let preview: string
let organiser: string
let torontoEvent: string
let hiddenEvent: string
let hiddenMarketEvent: string
let noCityEvent: string
let bangaloreEvent: string
let bengaluruEvent: string
let torontoVenue: string
let hiddenVenue: string
let bangaloreVenue: string

async function eventIn(city: string | null) {
  const id = await makeEvent(organiser)
  events.push(id)
  await db.events.update({ where: { id }, data: { city, curated_at: new Date(), title: `${WORD} ${id}` } })
  return id
}

async function get(route: { GET: (r: NextRequest) => Promise<Response> }, path: string, token: string, headers: Record<string, string> = {}) {
  const res = await route.GET(new NextRequest(`http://localhost/api/mobile/${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } }))
  expect(res.status).toBe(200)
  return (await res.json()).data
}
let limitSeq = 60
// `limit` is part of the events cache key: a fresh one per ask, except where a test wants the cache.
const eventIds = async (token: string, city: string | null, limit = limitSeq++) => {
  const q = city === null ? "" : `&city=${encodeURIComponent(city)}`
  const data = await get(eventsRoute, `events?limit=${limit}${q}`, token)
  return (data.events as { id: string }[]).map((e) => e.id)
}
const venueIds = async (token: string, city: string | null) => {
  const q = city === null ? "" : `&city=${encodeURIComponent(city)}`
  const data = await get(venuesRoute, `venues?limit=100${q}`, token)
  return ((data.venues ?? data) as { id: string }[]).map((v) => v.id)
}
const searchIds = async (token: string, city: string | null) => {
  const q = city === null ? "" : `&city=${encodeURIComponent(city)}`
  const data = await get(searchRoute, `events/search?q=${WORD}&limit=50${q}`, token)
  return (data.events as { id: string }[]).map((e) => e.id)
}
// The list filtered to this file's rows, so a row cannot be off the page: not.toContain means left out.
const searched = async (token: string) => {
  const data = await get(eventsRoute, `events?search=${WORD}&limit=${limitSeq++}`, token)
  return (data.events as { id: string }[]).map((e) => e.id)
}
const venuesSearched = async (token: string) => {
  const data = await get(venuesRoute, `venues?search=${tag}&limit=100`, token)
  return ((data.venues ?? data) as { id: string }[]).map((v) => v.id)
}
const cities = (token: string, headers: Record<string, string> = {}) => get(citiesRoute, "events/cities", token, headers)
type CityRow = { city: string; slug: string | null; access: string; eventCount: number; placeCount: number; launchState: string | null }
const findCity = (body: { cities: CityRow[] }, slug: string) => body.cities.find((c) => c.slug === slug)
const NEW_CLIENT = { "x-client-features": "travel1" }

beforeAll(async () => {
  organiser = await makeUser(testId("tc_org"), "organizer")
  plainUser = await makeUser(testId("tc_plain"))
  previewer = await makeUser(testId("tc_prev"))
  users.push(organiser, plainUser, previewer)
  await db.profiles.createMany({ data: [{ id: plainUser, onboarded: true, date_of_birth: new Date("1990-01-01") }, { id: previewer, onboarded: true, date_of_birth: new Date("1990-01-01") }] })
  const email = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })).email
  plain = signAccessToken(plainUser, await email(plainUser))
  preview = signAccessToken(previewer, await email(previewer))
  await db.market_previewers.create({ data: { user_id: previewer, market_code: "CA" } })

  await db.markets.create({ data: { code: HIDDEN_MARKET, name: "Qaland", currency: "XXX", locale: "en", launch_state: "hidden" } })
  const box = { centre_lat: 1, centre_lon: 1, min_lat: 0, min_lon: 0, max_lat: 2, max_lon: 2, timezone: "UTC" }
  await db.cities.createMany({
    data: [
      { ...box, market_code: "IN", slug: HIDDEN_SLUG, name: HIDDEN, launch_state: "hidden" },
      { ...box, market_code: HIDDEN_MARKET, slug: `qa-hm-${tag}`, name: IN_HIDDEN_MARKET, launch_state: "live" },
    ],
  })

  torontoEvent = await eventIn("Toronto")
  hiddenEvent = await eventIn(HIDDEN)
  hiddenMarketEvent = await eventIn(IN_HIDDEN_MARKET)
  noCityEvent = await eventIn(null)
  bangaloreEvent = await eventIn("Bangalore")
  bengaluruEvent = await eventIn("Bengaluru")
  const venue = async (name: string, city: string) => (await db.venues.create({ data: { name, city } })).id
  torontoVenue = await venue(`tc-to-${tag}`, "Toronto")
  hiddenVenue = await venue(`tc-hid-${tag}`, HIDDEN)
  bangaloreVenue = await venue(`tc-blr-${tag}`, "Bangalore")
  venues.push(torontoVenue, hiddenVenue, bangaloreVenue)
  clearCityCatalogue()
  clearCityPlaces()
})

afterAll(async () => {
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.market_previewers.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.cities.deleteMany({ where: { slug: { in: [HIDDEN_SLUG, `qa-hm-${tag}`] } } })
  await db.markets.deleteMany({ where: { code: HIDDEN_MARKET } })
  await closeDb()
})

describe("what M1 wrote on a migrate-deploy database", () => {
  it("has the seed: one default per market, Canada in preview", async () => {
    const seeded = await db.cities.findMany({ where: { market_code: { in: ["IN", "CA"] }, is_default: true }, select: { slug: true } })
    expect(seeded.map((c) => c.slug).sort()).toEqual(["bengaluru", "toronto"])
    expect(await db.markets.findUnique({ where: { code: "CA" }, select: { launch_state: true } })).toEqual({ launch_state: "preview" })
  })

  it("has the constraints schema.prisma cannot express, and they refuse", async () => {
    const box = { centre_lat: 1, centre_lon: 1, min_lat: 0, min_lon: 0, max_lat: 2, max_lon: 2, timezone: "UTC" }
    const add = (over: object) => db.cities.create({ data: { ...box, market_code: "IN", slug: testId("qa").replace(/[^a-z0-9]/gi, "").toLowerCase(), name: "Qa", ...over } })
    await expect(add({ is_default: true })).rejects.toThrow(/cities_one_default_per_market/)
    await expect(add({ timezone: "Not a zone" })).rejects.toThrow(/cities_timezone_known/)
    await expect(add({ min_lat: 3 })).rejects.toThrow(/cities_bounds_order/)
    await expect(add({ centre_lat: 5 })).rejects.toThrow(/cities_centre_in_bounds/)
    await expect(add({ slug: "Not A Slug" })).rejects.toThrow(/cities_slug_shape/)
    await expect(add({ default_licensed_min_age: 16 })).rejects.toThrow(/cities_licensed_min_age_floor/)
    const market = (over: object) => db.markets.create({ data: { code: "QQ", name: "Q", currency: "QQQ", locale: "en", ...over } })
    await expect(market({ code: "qq1" })).rejects.toThrow(/markets_code_shape/)
    await expect(market({ currency: "dollars" })).rejects.toThrow(/markets_currency_shape/)
  })
})

describe("a hidden city", () => {
  it("is absent from /events/cities, for an old client and a new one", async () => {
    for (const headers of [{}, NEW_CLIENT]) {
      const body = await cities(plain, headers)
      expect(findCity(body, HIDDEN_SLUG)).toBeUndefined()
      expect(body.cities.some((c: CityRow) => c.city === HIDDEN)).toBe(false)
    }
  })

  it("opens with nothing, and is not in the unscoped lists, even to a previewer", async () => {
    for (const token of [plain, preview]) {
      expect(await eventIds(token, HIDDEN)).toEqual([])
      expect(await eventIds(token, null)).not.toContain(hiddenEvent)
      expect(await venueIds(token, HIDDEN)).toEqual([])
      expect(await venueIds(token, null)).not.toContain(hiddenVenue)
      expect(await searchIds(token, HIDDEN)).toEqual([])
      expect(await searchIds(token, null)).not.toContain(hiddenEvent)
    }
  })

  it("a live city in a hidden market is hidden too", async () => {
    expect(await eventIds(plain, IN_HIDDEN_MARKET)).toEqual([])
    expect(await eventIds(plain, null)).not.toContain(hiddenMarketEvent)
    expect((await cities(plain, NEW_CLIENT)).countries.map((c: { code: string }) => c.code)).not.toContain(HIDDEN_MARKET)
  })
})

describe("a preview city", () => {
  it("is listed coming soon for a new client, at the zero it opens with, and its lists are empty", async () => {
    expect(findCity(await cities(plain, NEW_CLIENT), "toronto")).toMatchObject({ access: "comingSoon", launchState: "preview", eventCount: 0, placeCount: 0 })
    expect(await eventIds(plain, "Toronto")).toEqual([])
    expect(await venueIds(plain, "Toronto")).toEqual([])
    expect(await searchIds(plain, "Toronto")).toEqual([])
    expect(await searched(preview)).toContain(torontoEvent)
    expect(await searched(plain)).not.toContain(torontoEvent)
    expect(await eventIds(plain, null)).not.toContain(torontoEvent)
    expect(await venueIds(plain, null)).not.toContain(torontoVenue)
    expect(await searchIds(plain, null)).not.toContain(torontoEvent)
    const live = await get(venuesRoute, "venues?limit=100&order=live&city=Toronto", plain)
    expect(live.venues ?? live).toEqual([])
  })

  it("is not listed at all for an old client, whose list stays every field it reads", async () => {
    const body = await cities(plain)
    expect(findCity(body, "toronto")).toBeUndefined()
    expect(body.cities.every((c: CityRow) => c.access === "full")).toBe(true)
    expect(findCity(body, "bengaluru")).toEqual(expect.objectContaining({ city: "Bengaluru", eventCount: expect.any(Number), placeCount: expect.any(Number), centre: expect.anything() }))
  })

  it("opens for a previewer, count and list agreeing", async () => {
    const row = findCity(await cities(preview, NEW_CLIENT), "toronto")!
    expect(row).toMatchObject({ access: "full", launchState: "preview", placeCount: 1 })
    const listed = await eventIds(preview, "Toronto")
    expect(listed).toContain(torontoEvent)
    expect(row.eventCount).toBe(listed.length)
    expect(await venueIds(preview, "Toronto")).toContain(torontoVenue)
    expect(await searchIds(preview, "Toronto")).toContain(torontoEvent)
    expect(await eventIds(preview, null)).toContain(torontoEvent)
  })

  it("a page a previewer filled is not served to anybody else from the cache", async () => {
    const limit = 37
    expect(await eventIds(preview, "Toronto", limit)).toContain(torontoEvent)
    expect(await eventIds(plain, "Toronto", limit)).toEqual([])
    const unscoped = 38
    expect(await eventIds(preview, null, unscoped)).toContain(torontoEvent)
    expect(await eventIds(plain, null, unscoped)).not.toContain(torontoEvent)
  })

  it("the summary's cached counts do not cross from a previewer either", async () => {
    const a = await get(summaryRoute, "venues/summary?city=Toronto", preview)
    const b = await get(summaryRoute, "venues/summary?city=Toronto", plain)
    expect(a.total).toBe(1)
    expect(b.total).toBe(0)
  })
})

describe("the list's own search box", () => {
  it.each([[WORD], [WORD.slice(0, 1)]])("keeps the rule on the events list with search=%s (ranked and date paths)", async (q) => {
    const ask = async (token: string) => ((await get(eventsRoute, `events?search=${encodeURIComponent(q)}&limit=${limitSeq++}`, token)).events as { id: string }[]).map((e) => e.id)
    if (q === WORD) expect(await ask(preview)).toContain(torontoEvent)
    expect(await ask(plain)).not.toContain(torontoEvent)
    expect(await ask(plain)).not.toContain(hiddenEvent)
  })

  it("keeps the rule on the venues list, with the control on the same page", async () => {
    const asPlain = await venuesSearched(plain)
    expect(asPlain).toContain(bangaloreVenue)
    expect(asPlain).not.toContain(torontoVenue)
    expect(asPlain).not.toContain(hiddenVenue)
    expect(await venuesSearched(preview)).toContain(torontoVenue)
  })

  it("keeps a venue with no city", async () => {
    const none = await db.venues.create({ data: { name: `tc-none-${tag}`, city: null } })
    venues.push(none.id)
    expect(await venuesSearched(plain)).toContain(none.id)
  })

  it("/events/search's total counts what the page may show", async () => {
    const ask = async (token: string) => get(searchRoute, `events/search?q=${WORD}&limit=50`, token)
    const [a, b] = [await ask(plain), await ask(preview)]
    expect(a.pagination.totalCount).toBe(a.events.length)
    expect(b.pagination.totalCount).toBeGreaterThan(a.pagination.totalCount)
  })
})

describe("the unscoped summary and the tonight tier", () => {
  it("counts a closed city's venue only for its previewer", async () => {
    const [a, b] = [await get(summaryRoute, "venues/summary", preview), await get(summaryRoute, "venues/summary", plain)]
    expect(a.total).toBeGreaterThan(b.total)
  })

  it("a previewer's open-tonight count does not reach anybody else, in either order", async () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" }))
    await db.venues.update({ where: { id: torontoVenue }, data: { hours } })
    const city = "venues/summary?city=Vancouver"
    await db.venues.create({ data: { name: `tc-van-${tag}`, city: "Vancouver", hours } }).then((v) => venues.push(v.id))
    const asPlain = await get(summaryRoute, city, plain)
    const asPreview = await get(summaryRoute, city, preview)
    expect(asPlain.total).toBe(0)
    expect(asPlain.openTonightCount ?? 0).toBe(0)
    expect(asPreview.total).toBe(1)
    const live = await get(venuesRoute, "venues?limit=100&order=live&city=Toronto", preview)
    expect(((live.venues ?? live) as { id: string }[]).map((v) => v.id)).toContain(torontoVenue)
    expect((await get(venuesRoute, "venues?limit=100&order=live&city=Toronto", plain)).venues ?? []).toEqual([])
  })
})

describe("an alias", () => {
  it('"Bangalore" and "Bengaluru" are one city in every list, whichever is asked for', async () => {
    for (const asked of ["Bengaluru", "Bangalore", " bangalore "]) {
      const listed = await eventIds(plain, asked)
      expect(listed).toEqual(expect.arrayContaining([bangaloreEvent, bengaluruEvent]))
      expect(await venueIds(plain, asked)).toContain(bangaloreVenue)
      expect(await searchIds(plain, asked)).toEqual(expect.arrayContaining([bangaloreEvent, bengaluruEvent]))
    }
  })

  it("is one row in /events/cities, whose count opens with that count", async () => {
    const body = await cities(plain, NEW_CLIENT)
    expect(body.cities.filter((c: CityRow) => /^(bangalore|bengaluru)$/i.test(c.city))).toHaveLength(1)
    const row = findCity(body, "bengaluru")!
    expect(row.city).toBe("Bengaluru")
    expect(row.eventCount).toBe((await eventIds(plain, "Bengaluru", 100)).length)
  })
})

describe("the rows the rule must not lose", () => {
  it("an event with no city stays in the unscoped lists: a bare NOT would hide it", async () => {
    expect(await eventIds(plain, null)).toContain(noCityEvent)
    expect(await searchIds(plain, null)).toContain(noCityEvent)
  })

  it("an uncatalogued city is still browsable, listed with no country", async () => {
    const id = await eventIn(`Qaelse${tag}`)
    const row = (await cities(plain, NEW_CLIENT)).cities.find((c: CityRow) => c.city === `Qaelse${tag}`)
    expect(row).toMatchObject({ slug: null, country: null, access: "full", eventCount: 1 })
    expect(await eventIds(plain, `Qaelse${tag}`)).toEqual([id])
  })
})

describe("a city's spelling cannot get a row past the gate", () => {
  it.each([[" Toronto "], ["Toronto\t"], ["\u00a0Toronto"]])("%j is stored trimmed, so it is Toronto in every list", async (padded) => {
    const id = await eventIn(padded)
    expect((await db.events.findUniqueOrThrow({ where: { id }, select: { city: true } })).city).toBe("Toronto")
    expect(await eventIds(plain, null)).not.toContain(id)
    expect(await searchIds(plain, null)).not.toContain(id)
    expect(await eventIds(preview, "Toronto")).toContain(id)
  })

  it("trims on a venue too, and on an update", async () => {
    const created = await db.venues.create({ data: { name: testId("tc-pad"), city: " Toronto " } })
    venues.push(created.id)
    expect(created.city).toBe("Toronto")
    expect(await venueIds(plain, null)).not.toContain(created.id)
    const moved = await db.venues.update({ where: { id: created.id }, data: { city: "  Vancouver" } })
    expect(moved.city).toBe("Vancouver")
  })

  it.each([["Toronto, ON"], ["Toronto\u200b"], ["\ufeffToronto"], ["Toronto\u2003"], ["TORONTO, Ontario, Canada"]])("%j is Toronto, on a direct create", async (spelled) => {
    const made = await db.events.create({
      data: { slug: testId("sp"), title: `${WORD} sp`, description: "x", start_time: new Date(Date.now() - 3_600_000), end_time: new Date(Date.now() + 3_600_000), timezone: "UTC", status: "published", organizer_id: organiser, visibility: "public", city: spelled, curated_at: new Date() },
    })
    events.push(made.id)
    expect(cityKey(made.city)).toBe("toronto")
    expect(await searched(plain)).not.toContain(made.id)
    expect(await searched(preview)).toContain(made.id)
  })

  it("the database's normaliser and cityKey agree, so a stored row and the catalogue cannot differ", async () => {
    const cases = [" a ", "a\t", "\n a", "\u00a0a", "\ufeffa", "\u2003a\u2003", "a\u200b b", "a, b", ", b", "", "Saint John", "São Paulo"]
    for (const value of cases) {
      const [{ cleaned }] = await db.$queryRaw<{ cleaned: string }[]>`SELECT clean_city_text(${value}) AS cleaned`
      expect([value, cleaned.toLowerCase()]).toEqual([value, cityKey(value)])
    }
  })

  it("a spelling nothing matches is not closed: it opens under Elsewhere rather than vanishing. The known limit", async () => {
    const id = await eventIn(`Toronto Downtown${tag}`)
    expect(await searched(plain)).toContain(id)
    const row = (await cities(plain, NEW_CLIENT)).cities.find((c: CityRow) => c.city === `Toronto Downtown${tag}`)
    expect(row).toMatchObject({ slug: null, country: null, access: "full" })
  })

  it("a suburb the seed names is the city, so it is closed with it", async () => {
    const id = await eventIn("North York")
    expect(await eventIds(plain, null)).not.toContain(id)
    expect(await eventIds(preview, "Toronto")).toContain(id)
  })
})

describe("reads by id", () => {
  const eventStatus = async (token: string, id: string) =>
    (await eventRoute.GET(new NextRequest(`http://localhost/api/mobile/events/${id}`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ eventId: id }) })).status
  const venueStatus = async (route: { GET: typeof venueRoute.GET } | { GET: typeof upcomingRoute.GET }, token: string, id: string) =>
    (await route.GET(new NextRequest(`http://localhost/api/mobile/venues/${id}/x`, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ venueId: id }) })).status

  it("a hidden city's event and venue are 404 to everyone, previewer included", async () => {
    for (const token of [plain, preview]) {
      expect(await eventStatus(token, hiddenEvent)).toBe(404)
      expect(await eventStatus(token, hiddenMarketEvent)).toBe(404)
      expect(await venueStatus(venueRoute, token, hiddenVenue)).toBe(404)
      expect(await venueStatus(upcomingRoute, token, hiddenVenue)).toBe(404)
    }
  })

  it("a preview city's are 404 to a non-previewer and open to a previewer", async () => {
    expect(await eventStatus(plain, torontoEvent)).toBe(404)
    expect(await eventStatus(preview, torontoEvent)).toBe(200)
    expect(await venueStatus(venueRoute, plain, torontoVenue)).toBe(404)
    expect(await venueStatus(venueRoute, preview, torontoVenue)).toBe(200)
    expect(await venueStatus(upcomingRoute, plain, torontoVenue)).toBe(404)
    expect(await venueStatus(upcomingRoute, preview, torontoVenue)).toBe(200)
  })

  it("Go Live answers 404 in a city the person cannot open, with a body that is otherwise valid", async () => {
    const post = (token: string, id: string) =>
      liveRoute.POST(
        new NextRequest(`http://localhost/api/mobile/venues/${id}/live`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ latitude: 1, longitude: 1, minutes: 60 }),
        }),
        { params: Promise.resolve({ venueId: id }) }
      )
    expect((await post(plain, torontoVenue)).status).toBe(404)
    expect((await post(plain, hiddenVenue)).status).toBe(404)
    // Past the gate: the same venue answers a previewer with its next refusal, not 404.
    expect((await post(preview, torontoVenue)).status).not.toBe(404)
  })

  it("the rows with no catalogued city still open: a NULL city has no signal to gate on", async () => {
    expect(await eventStatus(plain, noCityEvent)).toBe(200)
    expect(await eventStatus(plain, bangaloreEvent)).toBe(200)
    expect(await venueStatus(venueRoute, plain, bangaloreVenue)).toBe(200)
  })

  it("the public share pages say unavailable for a hidden or preview city, and answer for a live one", async () => {
    expect(await readShareEvent(hiddenEvent)).toBeNull()
    expect(await readShareEvent(torontoEvent)).toBeNull()
    expect(await readShareVenue(hiddenVenue)).toBeNull()
    expect(await readShareVenue(torontoVenue)).toBeNull()
    expect(await readShareEvent(bengaluruEvent)).not.toBeNull()
    expect(await readShareVenue(bangaloreVenue)).not.toBeNull()
  })
})

describe("the event's own sub-routes", () => {
  const req = (token: string, method = "GET", body?: object) =>
    new NextRequest("http://localhost/api/mobile/x", {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const ctx = (eventId: string) => ({ params: Promise.resolve({ eventId }) })

  it("RSVP, favourite, interest and check-in are 404 in a closed city, and write nothing", async () => {
    for (const eventId of [torontoEvent, hiddenEvent]) {
      expect((await rsvpRoute.POST(req(plain, "POST", { status: "going" }), ctx(eventId))).status).toBe(404)
      expect((await favoriteRoute.POST(req(plain, "POST"), ctx(eventId))).status).toBe(404)
      expect((await interestRoute.POST(req(plain, "POST", { intent: "friendship" }), ctx(eventId))).status).toBe(404)
      expect((await checkinRoute.POST(req(plain, "POST", { latitude: 1, longitude: 1 }), ctx(eventId))).status).toBe(404)
    }
    const on = { user_id: plainUser, event_id: { in: [torontoEvent, hiddenEvent] } }
    expect(await db.event_rsvps.count({ where: on })).toBe(0)
    expect(await db.event_favorites.count({ where: on })).toBe(0)
    expect(await db.event_check_ins.count({ where: on })).toBe(0)
  })

  it("past the gate for a previewer: RSVP works", async () => {
    expect((await rsvpRoute.POST(req(preview, "POST", { status: "going" }), ctx(torontoEvent))).status).toBe(200)
    await db.event_rsvps.deleteMany({ where: { user_id: previewer, event_id: torontoEvent } })
  })

  it("the room's reads give a stranger to the room nothing", async () => {
    const shown = async (res: Response) => {
      const body = await res.json()
      return res.status === 200 ? JSON.stringify(body.data) : null
    }
    for (const res of [await peopleRoute.GET(req(plain), ctx(torontoEvent)), await chatRoute.GET(req(plain), ctx(torontoEvent)), await matchesRoute.GET(req(plain), ctx(torontoEvent))]) {
      expect(await shown(res)).toBeNull()
    }
    const crews = await crewsRoute.GET(req(plain), ctx(torontoEvent))
    expect(crews.status).not.toBe(200)
    void pollRoute
  })

  it("somebody checked in when the city closes keeps the event and the door; leaving ends it", async () => {
    const insider = await makeUser(testId("tc_in"))
    users.push(insider)
    await db.profiles.create({ data: { id: insider, onboarded: true, date_of_birth: new Date("1990-01-01") } })
    const { email } = await db.user.findUniqueOrThrow({ where: { id: insider }, select: { email: true } })
    const token = signAccessToken(insider, email)
    expect((await eventRoute.GET(new NextRequest("http://localhost/x", { headers: { authorization: `Bearer ${token}` } }), ctx(torontoEvent))).status).toBe(404)
    const checkIn = await db.event_check_ins.create({
      data: { event_id: torontoEvent, occurrence_id: await occurrenceOf(torontoEvent), user_id: insider, status: "checked_in", expires_at: new Date(Date.now() + 3_600_000) },
    })
    expect((await eventRoute.GET(new NextRequest("http://localhost/x", { headers: { authorization: `Bearer ${token}` } }), ctx(torontoEvent))).status).toBe(200)
    await db.event_check_ins.update({ where: { id: checkIn.id }, data: { status: "checked_out" } })
    expect((await eventRoute.GET(new NextRequest("http://localhost/x", { headers: { authorization: `Bearer ${token}` } }), ctx(torontoEvent))).status).toBe(404)
    await db.event_check_ins.delete({ where: { id: checkIn.id } })
  })

  it("/venues/:id/regular is 404 in a closed city, read and write", async () => {
    const vctx = { params: Promise.resolve({ venueId: torontoVenue }) }
    expect((await regularRoute.GET(req(plain), vctx)).status).toBe(404)
    expect((await regularRoute.PUT(req(plain, "PUT", { offers: true }), vctx)).status).toBe(404)
  })
})

describe("what is nested in an open page", () => {
  it("an open venue's upcoming lists leave out an event in a closed city", async () => {
    const eventId = await eventIn("Toronto")
    const openEvent = await eventIn("Bengaluru")
    await db.events.updateMany({ where: { id: { in: [eventId, openEvent] } }, data: { venue_id: bangaloreVenue, venue_link_status: "confirmed", start_time: new Date(Date.now() + 86_400_000), end_time: new Date(Date.now() + 90_000_000) } })
    const ids = async (token: string) => {
      const body = await get({ GET: (r) => upcomingRoute.GET(r, { params: Promise.resolve({ venueId: bangaloreVenue }) }) }, "x", token)
      return (body.events as { id: string }[]).map((e) => e.id)
    }
    expect(await ids(preview)).toContain(eventId)
    const asPlain = await ids(plain)
    expect(asPlain).toContain(openEvent)
    expect(asPlain).not.toContain(eventId)
    const detail = await get({ GET: (r) => venueRoute.GET(r, { params: Promise.resolve({ venueId: bangaloreVenue }) }) }, "x", plain)
    expect(JSON.stringify(detail)).not.toContain(eventId)
    expect(JSON.stringify(detail)).toContain(openEvent)
    const shared = await readShareVenue(bangaloreVenue)
    expect(JSON.stringify(shared)).not.toContain(eventId)
    expect(JSON.stringify(shared)).toContain(openEvent)
    await db.events.updateMany({ where: { id: { in: [eventId, openEvent] } }, data: { venue_id: null, venue_link_status: null } })
  })

  it("an open event names no closed venue, on its page or its share page", async () => {
    const eventId = await eventIn("Bengaluru")
    const fence = { type: "circle", lat: 43.6532, lng: -79.3832, radius: 200 }
    const area = `Qaarea${tag}`
    await db.venues.update({ where: { id: torontoVenue }, data: { geofence: fence, area } })
    await db.events.update({ where: { id: eventId }, data: { venue_id: torontoVenue, venue_link_status: "confirmed", latitude: 43.6532, longitude: -79.3832 } })
    const page = async (token: string) => get({ GET: (r) => eventRoute.GET(r, { params: Promise.resolve({ eventId }) }) }, "x", token)
    expect(JSON.stringify(await page(preview))).toContain(area)
    expect(JSON.stringify(await page(plain))).not.toContain(area)
    const shared = JSON.stringify(await readShareEvent(eventId))
    expect(shared).not.toContain(torontoVenue)
    expect(shared).not.toContain(area)
    await db.events.update({ where: { id: eventId }, data: { venue_id: null, venue_link_status: null } })
  })
})

describe("the places a person is standing in", () => {
  it("does not offer a closed city's event or venue; offers them to a previewer", async () => {
    const lat = 43.6532
    const lon = -79.3832
    const here = await eventIn("Toronto")
    await db.events.update({ where: { id: here }, data: { latitude: lat, longitude: lon, check_in_radius: 500 } })
    const place = await db.venues.create({
      data: { name: testId("tc-in"), city: "Toronto", latitude: lat, longitude: lon, geofence: { type: "circle", lat, lng: lon, radius: 500 } },
    })
    venues.push(place.id)
    const ask = async (token: string) => {
      const res = await insideRoute.POST(
        new NextRequest("http://localhost/api/mobile/checkins/inside", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ latitude: lat, longitude: lon }),
        })
      )
      expect(res.status).toBe(200)
      return JSON.stringify((await res.json()).data)
    }
    const asPlain = await ask(plain)
    const asPreview = await ask(preview)
    expect(asPreview).toContain(here)
    expect(asPreview).toContain(place.id)
    expect(asPlain).not.toContain(here)
    expect(asPlain).not.toContain(place.id)
  })
})

describe("where the device is", () => {
  const device = async (token: string, country?: string) => (await cities(token, { ...NEW_CLIENT, ...(country ? { "x-country": country } : {}) })).device

  it("in a country we do not serve, names no city", async () => {
    expect(await device(plain, "DE")).toEqual({ country: "DE", access: "none", citySlug: null })
    expect(await device(plain, HIDDEN_MARKET)).toEqual({ country: HIDDEN_MARKET, access: "none", citySlug: null })
  })

  it("in a preview country, names that country's city as coming soon; open for a previewer", async () => {
    expect(await device(plain, "ca")).toEqual({ country: "CA", access: "comingSoon", citySlug: "toronto" })
    expect(await device(preview, "CA")).toEqual({ country: "CA", access: "full", citySlug: "toronto" })
  })

  it("in a live country, names its default; with no header, nothing", async () => {
    expect(await device(plain, "IN")).toEqual({ country: "IN", access: "full", citySlug: "bengaluru" })
    expect(await device(plain)).toBeNull()
    expect((await cities(plain, NEW_CLIENT)).defaultCitySlug).toBe("bengaluru")
  })
})

describe("the API contract", () => {
  it("the real /events/cities answer is exactly the OpenAPI schema", async () => {
    const body = await cities(preview, { ...NEW_CLIENT, "x-country": "CA" })
    expect(EventCitiesResponseSchema.parse(body)).toEqual(body)
  })

  it("the profile response documents homeCitySlug", () => {
    expect(Object.keys(ProfileResponseSchema.shape.profile.unwrap().shape)).toContain("homeCitySlug")
  })
})

describe("homeCitySlug", () => {
  const put = (token: string, id: string, body: object) =>
    profileRoute.PUT(
      new NextRequest(`http://localhost/api/mobile/profiles/${id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ userId: id }) }
    )
  const read = async (token: string, id: string) => {
    const res = await profileRoute.GET(new NextRequest(`http://localhost/api/mobile/profiles/${id}`, { headers: { authorization: `Bearer ${token}` } }), {
      params: Promise.resolve({ userId: id }),
    })
    return (await res.json()).data
  }
  const stored = async (id: string) => (await db.profiles.findUniqueOrThrow({ where: { id }, select: { home_city: { select: { slug: true } } } })).home_city?.slug ?? null

  it("writes the row, and PUT and GET both say so", async () => {
    const res = await put(plain, plainUser, { homeCitySlug: "bengaluru" })
    expect(res.status).toBe(200)
    expect((await res.json()).data.profile.homeCitySlug).toBe("bengaluru")
    expect(await stored(plainUser)).toBe("bengaluru")
    expect((await read(plain, plainUser)).profile.homeCitySlug).toBe("bengaluru")
  })

  it("takes a preview city: a person in Toronto can say they live there", async () => {
    expect((await put(plain, plainUser, { homeCitySlug: "toronto" })).status).toBe(200)
    expect(await stored(plainUser)).toBe("toronto")
  })

  it("writes it on a person's first profile write too: the upsert's other branch", async () => {
    const fresh = await makeUser(testId("tc_fresh"))
    users.push(fresh)
    const { email } = await db.user.findUniqueOrThrow({ where: { id: fresh }, select: { email: true } })
    expect(await db.profiles.count({ where: { id: fresh } })).toBe(0)
    const res = await put(signAccessToken(fresh, email), fresh, { homeCitySlug: "toronto" })
    expect(res.status).toBe(200)
    expect(await stored(fresh)).toBe("toronto")
  })

  it("leaves it alone when another field is written", async () => {
    await put(plain, plainUser, { homeCitySlug: "bengaluru" })
    expect((await put(plain, plainUser, { bio: "still here" })).status).toBe(200)
    expect(await stored(plainUser)).toBe("bengaluru")
  })

  it("clears on null", async () => {
    await put(plain, plainUser, { homeCitySlug: "bengaluru" })
    const res = await put(plain, plainUser, { homeCitySlug: null })
    expect(res.status).toBe(200)
    expect((await res.json()).data.profile.homeCitySlug).toBeNull()
    expect(await stored(plainUser)).toBeNull()
  })

  it("refuses an unknown or hidden city and writes nothing", async () => {
    await put(plain, plainUser, { homeCitySlug: "bengaluru" })
    for (const slug of ["atlantis", HIDDEN_SLUG, `qa-hm-${tag}`]) {
      const res = await put(plain, plainUser, { homeCitySlug: slug })
      expect(res.status).toBe(400)
      expect((await res.json()).errorCode).toBe("VALIDATION_ERROR")
    }
    expect(await stored(plainUser)).toBe("bengaluru")
  })

  it("is the owner's: nobody else's read carries it, and no response carries the raw id", async () => {
    await put(plain, plainUser, { homeCitySlug: "bengaluru" })
    const theirs = await read(preview, plainUser)
    expect(JSON.stringify(theirs)).not.toMatch(/homeCitySlug|home_city/)
    const own = await read(plain, plainUser)
    expect(own.profile.home_city_id).toBeUndefined()
    const res = await put(plain, plainUser, { bio: "again" })
    expect((await res.json()).data.profile.home_city_id).toBeUndefined()
  })

  it("goes with the account, with its previewer row", async () => {
    const gone = await makeUser(testId("tc_gone"))
    users.push(gone)
    await db.profiles.create({ data: { id: gone, onboarded: true } })
    const { email } = await db.user.findUniqueOrThrow({ where: { id: gone }, select: { email: true } })
    const token = signAccessToken(gone, email)
    await put(token, gone, { homeCitySlug: "bengaluru" })
    await db.market_previewers.create({ data: { user_id: gone, market_code: "CA" } })
    const res = await accountRoute.DELETE(new NextRequest("http://localhost/api/mobile/account", { method: "DELETE", headers: { authorization: `Bearer ${token}` } }))
    expect(res.status).toBe(200)
    expect(await stored(gone)).toBeNull()
    expect(await db.market_previewers.count({ where: { user_id: gone } })).toBe(0)
  })
})
