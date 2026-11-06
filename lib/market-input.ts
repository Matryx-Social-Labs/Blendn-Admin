import { cityKey } from "./address"
import type { LaunchState } from "./cities"
import { Refusal } from "./refusal"

/*
 * What an admin types on /dashboard/markets, checked before anything is written.
 * Pure, so `market-actions.ts` stays the database half. The markets_and_cities
 * migration's CHECKs back only some of these: code, currency and slug shape, the
 * timezone shape, bounds order, centre inside bounds, and a licensed age of at
 * least 18. The coordinate ranges, the age ceiling of 21, the locale shape and a
 * timezone Intl actually knows are checked here alone.
 */

export const LAUNCH_STATES: readonly LaunchState[] = ["live", "preview", "hidden"]
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const LICENSED_AGE = { min: 18, max: 21 }

/** A server action's argument as the plain string it must be: an object such as `{ not: "" }` would be a Prisma operator. */
export function textFrom(value: unknown, max = 200): string {
  if (typeof value !== "string" || value.length > max) throw new Refusal("That is not a valid value.")
  return value
}

export function launchStateFrom(value: unknown): LaunchState {
  if (!LAUNCH_STATES.includes(value as LaunchState)) throw new Refusal("Choose Live, Preview or Hidden.")
  return value as LaunchState
}

/** A real IANA zone, as Intl knows it; `UTC` included. */
export function isKnownTimezone(zone: string): boolean {
  if (!/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/.test(zone)) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export interface CityInput {
  marketCode: string
  slug: string
  name: string
  /** Comma-separated spellings. */
  matchNames: string
  region?: string | null
  timezone: string
  centreLat: number | string
  centreLon: number | string
  minLat: number | string
  minLon: number | string
  maxLat: number | string
  maxLon: number | string
  /** Empty for none. */
  licensedMinAge?: number | string | null
  /** The admin confirmed that listed rows already naming this city leave the app until it is live. */
  takeOffline?: boolean
}

export interface CityRowInput {
  market_code: string
  slug: string
  name: string
  match_names: string[]
  region: string | null
  timezone: string
  centre_lat: number
  centre_lon: number
  min_lat: number
  min_lon: number
  max_lat: number
  max_lon: number
  default_licensed_min_age: number | null
}

const coordinate = (value: number | string, limit: number, axis: "Latitude" | "Longitude") => {
  const n = typeof value === "number" ? value : Number(String(value).trim() || Number.NaN)
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new Refusal(`${axis} is between -${limit} and ${limit}.`)
  return n
}

const text = (v: unknown) => (typeof v === "number" ? String(v) : v == null ? "" : textFrom(v))
const CITY_FIELDS = ["marketCode", "slug", "name", "region", "timezone", "centreLat", "centreLon", "minLat", "minLon", "maxLat", "maxLon", "licensedMinAge"] as const

/** Shared with the form: a refusal that a confirm can lift (`createCity`'s `takeOffline`). */
export const TAKES_OFFLINE = "already list"

export function cityRowFrom(raw: CityInput): CityRowInput {
  // The known fields only, each a string: a missing optional one is "", an unknown or __proto__ key never read.
  const input = {
    ...Object.fromEntries(CITY_FIELDS.map((k) => [k, text(raw[k])])),
    matchNames: textFrom(raw.matchNames, 2000),
  } as Record<keyof CityInput, string>
  const name = input.name.trim()
  if (!name) throw new Refusal("Name the city.")
  const slug = input.slug.trim()
  if (!SLUG.test(slug)) throw new Refusal("Lowercase letters, numbers and hyphens, like toronto.")
  const matchNames = [...new Set(input.matchNames.split(",").map(cityKey).filter(Boolean))]
  if (matchNames.length === 0) throw new Refusal("At least one spelling, comma-separated.")
  const timezone = input.timezone.trim()
  if (!isKnownTimezone(timezone)) throw new Refusal("Not a timezone we know. Use the IANA name, like America/Toronto.")
  // Stored as Intl names it: "america/toronto" is accepted and kept as "America/Toronto".
  const zone = new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone

  const lat = (v: number | string) => coordinate(v, 90, "Latitude")
  const lon = (v: number | string) => coordinate(v, 180, "Longitude")
  const [centreLat, minLat, maxLat] = [lat(input.centreLat), lat(input.minLat), lat(input.maxLat)]
  const [centreLon, minLon, maxLon] = [lon(input.centreLon), lon(input.minLon), lon(input.maxLon)]
  if (!(minLat < maxLat && minLon < maxLon)) throw new Refusal("Min must be less than max.")
  if (centreLat < minLat || centreLat > maxLat || centreLon < minLon || centreLon > maxLon) {
    throw new Refusal("The center must sit inside the bounds.")
  }

  const ageText = String(input.licensedMinAge ?? "").trim()
  const age = ageText === "" ? null : Number(ageText)
  if (age !== null && !(Number.isInteger(age) && age >= LICENSED_AGE.min && age <= LICENSED_AGE.max)) {
    throw new Refusal("A whole number from 18 to 21, or leave it empty.")
  }

  return {
    market_code: input.marketCode.trim(),
    slug,
    name,
    match_names: matchNames,
    region: input.region.trim() || null,
    timezone: zone,
    centre_lat: centreLat,
    centre_lon: centreLon,
    min_lat: minLat,
    min_lon: minLon,
    max_lat: maxLat,
    max_lon: maxLon,
    default_licensed_min_age: age,
  }
}

export interface MarketInput {
  code: string
  name: string
  currency: string
  locale: string
}

export function marketRowFrom(raw: MarketInput): MarketInput {
  const input = { code: textFrom(raw.code), name: textFrom(raw.name), currency: textFrom(raw.currency), locale: textFrom(raw.locale) }
  const code = input.code.trim()
  if (!/^[A-Z]{2}$/.test(code)) throw new Refusal("Two capital letters, like DE.")
  const name = input.name.trim()
  if (!name) throw new Refusal("Name the country.")
  const currency = input.currency.trim()
  if (!/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf("currency").includes(currency)) {
    throw new Refusal("Three capital letters, like EUR.")
  }
  const locale = input.locale.trim()
  if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(locale)) throw new Refusal("A language and region, like de-DE.")
  return { code, name, currency, locale }
}
