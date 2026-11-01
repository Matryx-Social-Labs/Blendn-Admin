import { cityKey } from "./address"
import { db } from "./db"
import { logger } from "./logger"

/*
 * The countries and cities Blendn serves, as rows (`markets`, `cities`). Adding a
 * country is INSERTs; nothing in code names one.
 *
 * ponytail: `events.city` and `venues.city` stay free text and are matched
 * through `match_names`, not a `city_id` FK, so installed clients and every
 * existing query keep working. Add the FK if the string match ever measurably hurts.
 */

const CATALOGUE_TTL_MS = 60 * 1000
const PREVIEWERS_TTL_MS = 60 * 1000
const PREVIEWERS_MAX_ENTRIES = 5000

export type LaunchState = "live" | "preview" | "hidden"

export interface MarketRow {
  code: string
  name: string
  launch_state: LaunchState
  sort: number
}

export interface CityRow {
  id: string
  market_code: string
  slug: string
  name: string
  match_names: string[]
  timezone: string
  launch_state: LaunchState
  is_default: boolean
  centre_lat: number
  centre_lon: number
  min_lat: number
  min_lon: number
  max_lat: number
  max_lon: number
  sort: number
}

export interface CatalogueCity {
  id: string
  slug: string
  name: string
  country: string
  timezone: string
  /** The lower of the city's own state and its market's. */
  launchState: LaunchState
  isDefault: boolean
  centre: { latitude: number; longitude: number }
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number }
  /** Every `cityKey` that means this city, sorted; always includes its display name. */
  matchKeys: string[]
}

export interface CatalogueMarket {
  code: string
  name: string
  launchState: LaunchState
  /** The market's default city, else its first that is not hidden. Null when all are. */
  defaultCitySlug: string | null
}

export interface Catalogue {
  markets: CatalogueMarket[]
  cities: CatalogueCity[]
  cityByKey: ReadonlyMap<string, CatalogueCity>
}

const RANK: Record<LaunchState, number> = { hidden: 0, preview: 1, live: 2 }
const lower = (a: LaunchState, b: LaunchState) => (RANK[a] <= RANK[b] ? a : b)
const bySort = <T extends { sort: number }>(rows: readonly T[]) => [...rows].sort((a, b) => a.sort - b.sort)

/** Pure, so the rules are tested without a database. A city whose market has no row is hidden. */
export function buildCatalogue(marketRows: readonly MarketRow[], cityRows: readonly CityRow[]): Catalogue {
  const markets = bySort(marketRows)
  const stateOf = new Map(markets.map((m) => [m.code, m.launch_state]))
  const cities = markets
    .flatMap((m) => bySort(cityRows.filter((c) => c.market_code === m.code)))
    .concat(cityRows.filter((c) => !stateOf.has(c.market_code)))
    .map(
      (c): CatalogueCity => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        country: c.market_code,
        timezone: c.timezone,
        launchState: lower(c.launch_state, stateOf.get(c.market_code) ?? "hidden"),
        isDefault: c.is_default,
        centre: { latitude: c.centre_lat, longitude: c.centre_lon },
        bounds: { minLat: c.min_lat, minLon: c.min_lon, maxLat: c.max_lat, maxLon: c.max_lon },
        matchKeys: [...new Set([c.name, ...c.match_names].map(cityKey).filter(Boolean))].sort(),
      })
    )

  const cityByKey = new Map<string, CatalogueCity>()
  for (const city of cities) {
    for (const key of city.matchKeys) {
      const holder = cityByKey.get(key)
      // The database cannot refuse this across rows; the earlier city keeps the name.
      if (holder) logger.error("Two cities claim one name", { key, kept: holder.slug, ignored: city.slug })
      else cityByKey.set(key, city)
    }
  }

  return {
    cities,
    cityByKey,
    markets: markets.map((m) => {
      const open = cities.filter((c) => c.country === m.code && c.launchState !== "hidden")
      return {
        code: m.code,
        name: m.name,
        launchState: m.launch_state,
        defaultCitySlug: (open.find((c) => c.isDefault) ?? open[0])?.slug ?? null,
      }
    }),
  }
}

/** The catalogue's city for any spelling a row or a client uses, whatever its state. Null when uncatalogued. */
export function cityFor(catalogue: Catalogue, name: string | null | undefined): CatalogueCity | null {
  return catalogue.cityByKey.get(cityKey(name)) ?? null
}

/** A stored `home_city_id` as the client names it. A row the catalogue has not caught up with reads as none. */
export function citySlugFor(catalogue: Catalogue, id: string | null | undefined): string | null {
  return catalogue.cities.find((c) => c.id === id)?.slug ?? null
}

type CachedCatalogue = { expiresAt: number; catalogue: Promise<Catalogue> } | null
type CachedPreviewers = Map<string, { expiresAt: number; markets: Promise<ReadonlySet<string>> }>
// On globalThis: Next bundles its own copy of a lib per layer (as lib/city-places.ts).
const shared = globalThis as typeof globalThis & {
  __blendnCityCatalogue?: CachedCatalogue
  __blendnMarketPreviewers?: CachedPreviewers
}

/**
 * Every country and city, read at most once a minute per instance. The promise
 * is cached so concurrent requests share one read; a failed read is dropped so
 * the next request retries.
 */
export function cityCatalogue(): Promise<Catalogue> {
  const now = Date.now()
  const cached = shared.__blendnCityCatalogue
  if (cached && cached.expiresAt > now) return cached.catalogue
  const catalogue = Promise.all([db.markets.findMany(), db.cities.findMany()])
    .then(([markets, cities]) => buildCatalogue(markets, cities))
    .catch((error) => {
      if (shared.__blendnCityCatalogue?.catalogue === catalogue) shared.__blendnCityCatalogue = null
      throw error
    })
  shared.__blendnCityCatalogue = { expiresAt: now + CATALOGUE_TTL_MS, catalogue }
  return catalogue
}

const NO_MARKETS: ReadonlySet<string> = new Set()

/**
 * The preview markets this person sees fully. One read per person per minute,
 * and none at all while nothing is in preview. A previewer removed by an admin
 * loses access within the minute.
 */
export function previewMarketsFor(userId: string, catalogue: Catalogue): Promise<ReadonlySet<string>> {
  if (!catalogue.cities.some((c) => c.launchState === "preview")) return Promise.resolve(NO_MARKETS)
  const cache = (shared.__blendnMarketPreviewers ??= new Map())
  const now = Date.now()
  const hit = cache.get(userId)
  if (hit && hit.expiresAt > now) return hit.markets
  const markets: Promise<ReadonlySet<string>> = db.market_previewers
    .findMany({ where: { user_id: userId }, select: { market_code: true } })
    .then((rows) => new Set(rows.map((r) => r.market_code)))
    .catch((error) => {
      if (cache.get(userId)?.markets === markets) cache.delete(userId)
      throw error
    })
  if (cache.size >= PREVIEWERS_MAX_ENTRIES) cache.clear()
  cache.set(userId, { expiresAt: now + PREVIEWERS_TTL_MS, markets })
  return markets
}
