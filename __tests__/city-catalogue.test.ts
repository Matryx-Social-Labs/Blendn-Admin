import { readFileSync } from "fs"
import { join } from "path"

import { buildCatalogue, cityFor, type CityRow, type MarketRow } from "@/lib/cities"
import { cityAccess, citiesResponse, cityRule, cityRuleWhere, deviceCountryFrom, wantsPreviewRows } from "@/lib/browse-scope"
import { buildEventsCacheKey } from "@/lib/events-cache-key"

const market = (over: Partial<MarketRow>): MarketRow => ({ code: "AA", name: "Aland", launch_state: "live", sort: 0, ...over })
const city = (over: Partial<CityRow>): CityRow => ({
  id: `id-${over.slug}`,
  market_code: "AA",
  slug: "alpha",
  name: "Alpha",
  match_names: [],
  timezone: "Etc/UTC",
  launch_state: "live",
  is_default: false,
  centre_lat: 1,
  centre_lon: 2,
  min_lat: 0,
  min_lon: 1,
  max_lat: 2,
  max_lon: 3,
  sort: 0,
  ...over,
})

const catalogue = buildCatalogue(
  [market({}), market({ code: "BB", name: "Bland", launch_state: "preview", sort: 1 }), market({ code: "CC", name: "Cland", launch_state: "hidden", sort: 2 })],
  [
    city({ slug: "alpha", name: "Alpha", match_names: ["alpha", "alfa"], is_default: true }),
    city({ slug: "gamma", name: "Gamma", launch_state: "hidden", sort: 1 }),
    city({ slug: "beta", name: "Beta", market_code: "BB", launch_state: "preview", is_default: true }),
    // Live on its own row, in a market that is only a preview.
    city({ slug: "delta", name: "Delta", market_code: "BB", launch_state: "live", sort: 1 }),
    // Live on its own row, in a hidden market.
    city({ slug: "eps", name: "Eps", market_code: "CC", launch_state: "live", is_default: true }),
  ]
)
const NONE = new Set<string>()
const PREVIEWER = new Set(["BB"])
const named = (name: string) => cityFor(catalogue, name)!

describe("cityFor", () => {
  it("matches an alias, in any case, padded", () => {
    expect(cityFor(catalogue, "alfa")?.slug).toBe("alpha")
    expect(cityFor(catalogue, "  ALFA ")?.slug).toBe("alpha")
  })

  it("matches the display name even when match_names leaves it out", () => {
    expect(cityFor(catalogue, "Beta")?.slug).toBe("beta")
  })

  it("is null for an uncatalogued, blank or missing name", () => {
    expect(cityFor(catalogue, "Nowhere")).toBeNull()
    expect(cityFor(catalogue, "  ")).toBeNull()
    expect(cityFor(catalogue, null)).toBeNull()
    expect(cityFor(catalogue, undefined)).toBeNull()
  })

  it("does not substring-match: a name is one key", () => {
    expect(cityFor(catalogue, "alph")).toBeNull()
  })
})

describe("launch state is min(market, city)", () => {
  it.each([
    ["Alpha", "live"],
    ["Gamma", "hidden"],
    ["Beta", "preview"],
    ["Delta", "preview"], // live city, preview market
    ["Eps", "hidden"], // live city, hidden market
  ])("%s is %s", (name, state) => {
    expect(named(name).launchState).toBe(state)
  })

  it("a city in a market with no row is hidden, not served", () => {
    const orphan = buildCatalogue([], [city({ slug: "orphan", name: "Orphan" })])
    expect(cityFor(orphan, "Orphan")?.launchState).toBe("hidden")
  })
})

describe("cityAccess", () => {
  it("opens a live city for everyone", () => expect(cityAccess(named("Alpha"), NONE)).toBe("full"))
  it("keeps a preview city coming soon for everyone else", () => expect(cityAccess(named("Beta"), NONE)).toBe("comingSoon"))
  it("opens a preview city for its market's previewer", () => expect(cityAccess(named("Beta"), PREVIEWER)).toBe("full"))
  it("a previewer of another market gets nothing extra", () => expect(cityAccess(named("Beta"), new Set(["AA"]))).toBe("comingSoon"))
  it("a previewer never opens a hidden city", () => expect(cityAccess(named("Eps"), new Set(["CC"]))).toBe("hidden"))
})

describe("cityRule", () => {
  it("scopes a catalogued city to all its spellings, however it was asked for", () => {
    const keys = ["alfa", "alpha"]
    expect(cityRule(catalogue, "alfa", NONE)).toEqual({ only: keys })
    expect(cityRule(catalogue, " ALPHA ", NONE)).toEqual({ only: keys })
  })

  it("leaves an uncatalogued city as its own key", () => {
    expect(cityRule(catalogue, " Nowhere ", NONE)).toEqual({ only: ["nowhere"] })
  })

  it("answers nothing for a hidden city and a preview city a person cannot open", () => {
    expect(cityRule(catalogue, "Gamma", PREVIEWER)).toEqual({ only: [] })
    expect(cityRule(catalogue, "Beta", NONE)).toEqual({ only: [] })
    expect(cityRule(catalogue, "Beta", PREVIEWER)).toEqual({ only: ["beta"] })
  })

  it("with no city, excludes exactly what this viewer may not open", () => {
    expect(cityRule(catalogue, undefined, NONE)).toEqual({ except: ["beta", "delta", "eps", "gamma"] })
    expect(cityRule(catalogue, "   ", PREVIEWER)).toEqual({ except: ["eps", "gamma"] })
  })
})

describe("cityRuleWhere", () => {
  it("is the literal, case-insensitive match for one name", () => {
    expect(cityRuleWhere({ only: ["a_b"] })).toEqual({ city: { equals: "a\\_b", mode: "insensitive" } })
  })

  it("ORs several names", () => {
    expect(cityRuleWhere({ only: ["a", "b"] })).toEqual({
      OR: [{ city: { equals: "a", mode: "insensitive" } }, { city: { equals: "b", mode: "insensitive" } }],
    })
  })

  it("matches nothing for an empty scope, not everything", () => {
    expect(cityRuleWhere({ only: [] })).toEqual({ city: { in: [] } })
  })

  it("adds nothing when nothing is excluded", () => {
    expect(cityRuleWhere({ except: [] })).toEqual({})
  })

  it("keeps NULL-city rows through an exclusion: a bare NOT would hide them", () => {
    expect(cityRuleWhere({ except: ["a"] })).toEqual({
      OR: [{ city: null }, { NOT: { OR: [{ city: { equals: "a", mode: "insensitive" } }] } }],
    })
  })
})

describe("the events cache key", () => {
  const key = (cityRule: { only: string[] } | { except: string[] }) =>
    buildEventsCacheKey({ page: 1, limit: 20, viewerAge: 30, sortBy: "start_time", sortOrder: "asc", cityRule })

  it("differs between a previewer and everybody else: a page must not cross between them", () => {
    expect(key({ only: ["beta"] })).not.toBe(key({ only: [] }))
    expect(key({ except: ["eps"] })).not.toBe(key({ except: ["beta", "eps"] }))
  })
})

describe("wantsPreviewRows and deviceCountryFrom", () => {
  it("reads the feature out of a comma-separated header", () => {
    expect(wantsPreviewRows("travel1")).toBe(true)
    expect(wantsPreviewRows("other, travel1")).toBe(true)
    expect(wantsPreviewRows("travel11")).toBe(false)
    expect(wantsPreviewRows(null)).toBe(false)
  })

  it("takes a two-letter country in any case and nothing else", () => {
    expect(deviceCountryFrom("de")).toBe("DE")
    expect(deviceCountryFrom(" CA ")).toBe("CA")
    expect(deviceCountryFrom("Germany")).toBeNull()
    expect(deviceCountryFrom("")).toBeNull()
    expect(deviceCountryFrom(null)).toBeNull()
  })
})

describe("the /events/cities answer", () => {
  const events = [
    { city: "alfa", latitude: 1, longitude: 2 },
    { city: "Alpha", latitude: 1, longitude: 2 },
    { city: "Gamma", latitude: 1, longitude: 2 },
    { city: "Beta", latitude: 9, longitude: 9 },
    { city: "Eps", latitude: 1, longitude: 2 },
    { city: "Typoville", latitude: 5, longitude: 6 },
  ]
  const answer = (over: Partial<Parameters<typeof citiesResponse>[0]> = {}) =>
    citiesResponse({ catalogue, events, places: [], previewMarkets: NONE, wantsPreview: true, deviceCountry: null, ...over })
  const row = (body: ReturnType<typeof answer>, name: string) => body.cities.find((c) => c.city === name)

  it("folds aliases into one row under the catalogue's name, with the additive fields", () => {
    expect(row(answer(), "Alpha")).toEqual({
      city: "Alpha",
      eventCount: 2,
      placeCount: 0,
      centre: { latitude: 1, longitude: 2 },
      slug: "alpha",
      country: "AA",
      launchState: "live",
      timezone: "Etc/UTC",
      bounds: { minLat: 0, minLon: 1, maxLat: 2, maxLon: 3 },
      isDefault: true,
      access: "full",
    })
    expect(row(answer(), "alfa")).toBeUndefined()
  })

  it("drops a hidden city and a live city in a hidden market", () => {
    expect(row(answer(), "Gamma")).toBeUndefined()
    expect(row(answer(), "Eps")).toBeUndefined()
  })

  it("lists an uncatalogued city with no country, so the client files it under Elsewhere", () => {
    expect(row(answer(), "Typoville")).toEqual({
      city: "Typoville",
      eventCount: 1,
      placeCount: 0,
      centre: { latitude: 5, longitude: 6 },
      slug: null,
      country: null,
      launchState: null,
      timezone: null,
      bounds: null,
      isDefault: false,
      access: "full",
    })
  })

  it("a new client sees a preview city as coming soon, at zero, because that is what it opens with", () => {
    expect(row(answer(), "Beta")).toMatchObject({
      slug: "beta",
      access: "comingSoon",
      launchState: "preview",
      eventCount: 0,
      placeCount: 0,
      centre: { latitude: 1, longitude: 2 },
    })
  })

  it("an old client never sees a preview city: it would open empty", () => {
    const old = answer({ wantsPreview: false })
    expect(row(old, "Beta")).toBeUndefined()
    expect(row(old, "Delta")).toBeUndefined()
    expect(old.cities.every((c) => c.access === "full")).toBe(true)
  })

  it("an old client still reads the same fields, in the same busiest-first order", () => {
    const old = answer({ wantsPreview: false })
    expect(old.cities.map((c) => c.city)).toEqual(["Alpha", "Typoville"])
    expect(old.cities[0]).toMatchObject({ city: "Alpha", eventCount: 2, placeCount: 0, centre: { latitude: 1, longitude: 2 } })
  })

  it("a previewer gets the preview city open, with its real count, on either client", () => {
    for (const wantsPreview of [true, false]) {
      expect(row(answer({ previewMarkets: PREVIEWER, wantsPreview }), "Beta")).toMatchObject({
        access: "full",
        launchState: "preview",
        eventCount: 1,
        centre: { latitude: 9, longitude: 9 },
      })
    }
  })

  it("lists a live market's default city with no rows, so the default always resolves", () => {
    const body = answer({ events: [] })
    expect(row(body, "Alpha")).toMatchObject({ eventCount: 0, placeCount: 0, centre: { latitude: 1, longitude: 2 } })
    expect(body.defaultCitySlug).toBe("alpha")
  })

  it("a market with no default row still resolves: its first open city is named, so it is listed", () => {
    const noDefault = buildCatalogue([market({})], [city({ slug: "alpha" }), city({ slug: "other", name: "Other", sort: 1 })])
    const body = citiesResponse({ catalogue: noDefault, events: [], places: [], previewMarkets: NONE, wantsPreview: true, deviceCountry: "AA" })
    expect(body.defaultCitySlug).toBe("alpha")
    expect(body.device?.citySlug).toBe("alpha")
    expect(body.cities.map((c) => c.slug)).toEqual(["alpha"])
  })

  it("does not list any other live city with no rows", () => {
    const withEmpty = buildCatalogue([market({})], [city({ slug: "alpha", is_default: true }), city({ slug: "empty", name: "Empty", sort: 1 })])
    const body = citiesResponse({ catalogue: withEmpty, events: [], places: [], previewMarkets: NONE, wantsPreview: true, deviceCountry: null })
    expect(body.cities.map((c) => c.slug)).toEqual(["alpha"])
  })

  it("lists the countries served, never a hidden one", () => {
    expect(answer().countries).toEqual([
      { code: "AA", name: "Aland", launchState: "live", defaultCitySlug: "alpha" },
      { code: "BB", name: "Bland", launchState: "preview", defaultCitySlug: "beta" },
    ])
  })

  it("a live market whose cities are all hidden is not a country served", () => {
    const empty = buildCatalogue([market({})], [city({ slug: "x", name: "X", launch_state: "hidden", is_default: true })])
    const body = citiesResponse({ catalogue: empty, events: [], places: [], previewMarkets: NONE, wantsPreview: true, deviceCountry: null })
    expect(body.countries).toEqual([])
    expect(body.defaultCitySlug).toBeNull()
  })

  describe("device", () => {
    it("is null when the client did not say", () => expect(answer().device).toBeNull())

    it("in a live country, names its default city", () => {
      expect(answer({ deviceCountry: "AA" }).device).toEqual({ country: "AA", access: "full", citySlug: "alpha" })
    })

    it("in a preview country, is coming soon with that country's city, not another country's", () => {
      expect(answer({ deviceCountry: "BB" }).device).toEqual({ country: "BB", access: "comingSoon", citySlug: "beta" })
    })

    it("in a preview country, is open for its previewer", () => {
      expect(answer({ deviceCountry: "BB", previewMarkets: PREVIEWER }).device).toEqual({ country: "BB", access: "full", citySlug: "beta" })
    })

    it("in a country we do not serve, names no city at all", () => {
      expect(answer({ deviceCountry: "DE" }).device).toEqual({ country: "DE", access: "none", citySlug: null })
    })

    it("in a hidden market, is the same answer as a country we have never heard of", () => {
      expect(answer({ deviceCountry: "CC" }).device).toEqual({ country: "CC", access: "none", citySlug: null })
    })
  })

  it("the fallback default is a live market's, never a preview one's", () => {
    const previewFirst = buildCatalogue(
      [market({ code: "BB", launch_state: "preview", sort: 0 }), market({ sort: 1 })],
      [city({ slug: "beta", name: "Beta", market_code: "BB", launch_state: "preview", is_default: true }), city({ slug: "alpha", is_default: true })]
    )
    const body = citiesResponse({ catalogue: previewFirst, events: [], places: [], previewMarkets: NONE, wantsPreview: true, deviceCountry: null })
    expect(body.defaultCitySlug).toBe("alpha")
  })
})

/*
 * Structural: "a new country is rows" is only true while no code on this path
 * names a place. Every seeded name, read from the migration, not typed here, so
 * a city added to the seed is covered without touching this test.
 */
describe("the catalogue code names no country or city", () => {
  const migration = readFileSync(join(__dirname, "../prisma/migrations/20261101160000_markets_and_cities/migration.sql"), "utf8")
  const seeded = [
    ...[...migration.matchAll(/^\s+\('[A-Z]{2}', '([^']+)', '[A-Z]{3}'/gm)].map((m) => m[1]),
    ...[...migration.matchAll(/^\s+\('[A-Z]{2}', '([^']+)', '([^']+)', ARRAY\[([^\]]*)\]/gm)].flatMap((m) => [
      m[1],
      m[2],
      ...m[3].split(",").map((name) => name.replace(/'/g, "")),
    ]),
  ]
  const names = [...new Set(seeded.map((s) => s.toLowerCase()).filter(Boolean))]
  const executable = (path: string) =>
    readFileSync(join(__dirname, "..", path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .toLowerCase()

  it("reads every seeded name out of the migration", () => {
    expect(names).toEqual(expect.arrayContaining(["india", "canada", "bengaluru", "bangalore", "toronto", "vancouver"]))
  })

  it.each(["lib/cities.ts", "lib/browse-scope.ts", "app/api/mobile/events/cities/route.ts"])("%s", (path) => {
    const source = executable(path)
    expect(names.filter((n) => new RegExp(`\\b${n}\\b`).test(source))).toEqual([])
  })
})
