import type { Prisma } from "@prisma/client"

import { browseCities, cityKey, type BrowseCity } from "./address"
import { cityCatalogue, cityFor, previewMarketsFor, type Catalogue, type CatalogueCity, type LaunchState } from "./cities"
import { likeLiteral } from "./like-literal"

/*
 * Which cities' rows a viewer may see, written once, so the events list, the
 * places list, search and the city picker cannot disagree. Pure: the catalogue
 * and the viewer's preview markets come from `lib/cities.ts`, and `viewerCityRule`
 * is the one read that fetches them.
 */

export type CityAccess = "full" | "comingSoon" | "hidden"

export function cityAccess(city: CatalogueCity, previewMarkets: ReadonlySet<string>): CityAccess {
  if (city.launchState === "hidden") return "hidden"
  if (city.launchState === "live" || previewMarkets.has(city.country)) return "full"
  return "comingSoon"
}

/** `only`: rows in these names, and an empty list is none at all. `except`: rows anywhere but these names, NULL city included. */
export type CityRule = { only: string[] } | { except: string[] }

/**
 * The rule for a `city` parameter. A catalogued city means all its spellings; an
 * uncatalogued one is its own key, as it was before the catalogue. A city this
 * viewer may not open answers nothing; with no city, its rows are left out.
 */
export function cityRule(catalogue: Catalogue, city: string | undefined, previewMarkets: ReadonlySet<string>): CityRule {
  const key = cityKey(city)
  if (!key) {
    const closed = catalogue.cities.filter((c) => cityAccess(c, previewMarkets) !== "full")
    return { except: closed.flatMap((c) => c.matchKeys).sort() }
  }
  const found = cityFor(catalogue, key)
  if (!found) return { only: [key] }
  return { only: cityAccess(found, previewMarkets) === "full" ? found.matchKeys : [] }
}

/** The rule for this viewer and this `city` parameter. */
export async function viewerCityRule(userId: string, city: string | undefined): Promise<CityRule> {
  const catalogue = await cityCatalogue()
  return cityRule(catalogue, city, await previewMarketsFor(userId, catalogue))
}

/**
 * The same gate for a read by id, so a closed city's row is not one link away.
 * `userId` null is somebody signed out (a public share page): no previews. A NULL
 * or uncatalogued city has no signal to gate on, and opens as it lists.
 */
export async function mayOpenCity(userId: string | null, city: string | null | undefined): Promise<boolean> {
  const catalogue = await cityCatalogue()
  const found = cityFor(catalogue, city)
  if (!found) return true
  const previewMarkets = userId ? await previewMarketsFor(userId, catalogue) : new Set<string>()
  return cityAccess(found, previewMarkets) === "full"
}

const isName = (key: string) => ({ city: { equals: likeLiteral(key), mode: "insensitive" as const } })

/** The rule as a `where` fragment that fits events and venues alike. Put it under `AND`: a search assigns `OR` outright. */
export function cityRuleWhere(rule: CityRule) {
  if ("only" in rule) {
    if (rule.only.length === 0) return { city: { in: [] as string[] } }
    return rule.only.length === 1 ? isName(rule.only[0]) : { OR: rule.only.map(isName) }
  }
  if (rule.except.length === 0) return {}
  // The explicit NULL: a bare NOT is NULL, so false, for a row with no city.
  return { OR: [{ city: null }, { NOT: { OR: rule.except.map(isName) } }] }
}

// Compile-time check that the fragment is valid on both tables.
cityRuleWhere satisfies (rule: CityRule) => Prisma.eventsWhereInput & Prisma.venuesWhereInput

const TRAVEL_FEATURE = "travel1"
const COUNTRY_CODE = /^[A-Z]{2}$/

/** `X-Client-Features`: only a build that knows "coming soon" is sent the rows it would otherwise open empty. */
export function wantsPreviewRows(header: string | null): boolean {
  return (header ?? "").split(",").some((feature) => feature.trim() === TRAVEL_FEATURE)
}

/** `X-Country`: the device's ISO country, or null when it did not say or said nonsense. */
export function deviceCountryFrom(header: string | null): string | null {
  const code = (header ?? "").trim().toUpperCase()
  return COUNTRY_CODE.test(code) ? code : null
}

type PointRow = { city: string | null; latitude: number | null; longitude: number | null }

export interface CitiesResponseInput {
  catalogue: Catalogue
  events: readonly PointRow[]
  places: readonly PointRow[]
  previewMarkets: ReadonlySet<string>
  wantsPreview: boolean
  deviceCountry: string | null
}

export interface PickerCity extends BrowseCity {
  /** The next five are null, and `isDefault` false, for an uncatalogued city: the client files it under "Elsewhere". */
  slug: string | null
  country: string | null
  launchState: LaunchState | null
  timezone: string | null
  bounds: CatalogueCity["bounds"] | null
  isDefault: boolean
  access: "full" | "comingSoon"
}

function pickerRow(row: BrowseCity, city: CatalogueCity | null, access: CityAccess): PickerCity {
  if (!city) {
    return { ...row, slug: null, country: null, launchState: null, timezone: null, bounds: null, isDefault: false, access: "full" }
  }
  return {
    ...row,
    centre: row.centre ?? city.centre,
    slug: city.slug,
    country: city.country,
    launchState: city.launchState,
    timezone: city.timezone,
    bounds: city.bounds,
    isDefault: city.isDefault,
    access: access === "comingSoon" ? "comingSoon" : "full",
  }
}

/**
 * The answer of `GET /events/cities`.
 *
 * Rows the viewer may open are folded onto the catalogue's name, so the counts
 * match what the city rule returns. Beyond the cities with rows it lists: a
 * preview city (for a client that knows "coming soon"), at zero because that is
 * what it opens with for this viewer, and a served market's default, so that
 * `defaultCitySlug` always resolves. Any other city with no rows stays off the
 * list, so a catalogue row alone never opens an empty city.
 *
 * `device` is what stops a person being told another country's city is near
 * them: `citySlug` is only ever a city in `country`, and null where we are not.
 */
export function citiesResponse(input: CitiesResponseInput) {
  const { catalogue, previewMarkets, wantsPreview, deviceCountry } = input
  const foldable = (rows: readonly PointRow[]) =>
    rows.flatMap((row) => {
      const city = cityFor(catalogue, row.city)
      if (!city) return [row]
      return cityAccess(city, previewMarkets) === "full" ? [{ ...row, city: city.name }] : []
    })

  const withRows = browseCities(foldable(input.events), foldable(input.places)).map((row) => {
    return pickerRow(row, cityFor(catalogue, row.city), "full")
  })
  const liveCities = catalogue.cities.filter((c) => c.launchState === "live")
  const fallback = liveCities.find((c) => c.isDefault) ?? liveCities[0]
  const listed = new Set(withRows.map((c) => c.slug))
  const withoutRows = catalogue.cities
    .filter((c) => !listed.has(c.slug))
    .flatMap((c) => {
      const access = cityAccess(c, previewMarkets)
      const named = c.slug === fallback?.slug || catalogue.markets.some((m) => m.defaultCitySlug === c.slug)
      const lists = access === "comingSoon" ? wantsPreview : access === "full" && (named || c.launchState === "preview")
      return lists ? [pickerRow({ city: c.name, eventCount: 0, placeCount: 0, centre: null }, c, access)] : []
    })

  const served = catalogue.markets.filter((m) => m.launchState !== "hidden" && m.defaultCitySlug !== null)
  const bySlug = (slug: string | null) => catalogue.cities.find((c) => c.slug === slug)
  const here = deviceCountry === null ? undefined : served.find((m) => m.code === deviceCountry)
  const hereCity = bySlug(here?.defaultCitySlug ?? null)

  return {
    cities: [...withRows, ...withoutRows],
    countries: served.map((m) => ({ code: m.code, name: m.name, launchState: m.launchState, defaultCitySlug: m.defaultCitySlug })),
    /** A live market's default: where to browse with no device country, or from a country we do not serve. */
    defaultCitySlug: fallback?.slug ?? null,
    device:
      deviceCountry === null
        ? null
        : {
            country: deviceCountry,
            access: hereCity ? cityAccess(hereCity, previewMarkets) : ("none" as const),
            citySlug: hereCity?.slug ?? null,
          },
  }
}
