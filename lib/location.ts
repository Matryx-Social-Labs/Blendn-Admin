import { cityFrom, type NominatimAddress } from "./address"

const coordinateCache = new Map<string, string | null>()

function toNumber(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseCoordinateLocation(
  location: string
): { lat: number; lon: number } | null {
  const trimmed = location.trim()
  const match = trimmed.match(
    /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/
  )
  if (!match) return null

  const lat = toNumber(match[1])
  const lon = toNumber(match[2])

  if (lat === null || lon === null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null

  return { lat, lon }
}

export async function reverseGeocodeCity(
  lat: number,
  lon: number
): Promise<string | null> {
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`
  if (coordinateCache.has(cacheKey)) {
    return coordinateCache.get(cacheKey) ?? null
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3500)

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`,
      {
        headers: {
          "Accept": "application/json",
          // Without this Nominatim answers in the local language, so the same
          // venue is "München" here and "Munich" from a screen that does ask.
          // Two spellings of one city split it in every list that groups by name.
          "Accept-Language": "en",
          "User-Agent": "blendn-admin/1.0",
        },
        signal: controller.signal,
        cache: "force-cache",
      }
    )

    if (!response.ok) {
      coordinateCache.set(cacheKey, null)
      return null
    }

    const data = (await response.json()) as { address?: NominatimAddress }

    const normalized = cityFrom(data.address)
    coordinateCache.set(cacheKey, normalized)
    return normalized
  } catch {
    coordinateCache.set(cacheKey, null)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function normalizeLocationToCity(
  location: string | null | undefined,
  budget?: GeocodeBudget
): Promise<string | null> {
  if (!location) return null
  const trimmed = location.trim()
  if (!trimmed) return null

  const coordinates = parseCoordinateLocation(trimmed)
  if (!coordinates) return trimmed

  /*
   * A `city` that is literally "12.97,77.59" geocodes too, which is the second
   * way into Nominatim from a read path -- and the one the budget missed at
   * first, because `resolveEventCity` consults this before it reaches its own
   * coordinate branch. Same budget, both doors.
   */
  const cacheKey = `${coordinates.lat.toFixed(4)},${coordinates.lon.toFixed(4)}`
  if (coordinateCache.has(cacheKey)) return coordinateCache.get(cacheKey) ?? null
  if (budget && !budget.take()) return null

  return reverseGeocodeCity(coordinates.lat, coordinates.lon)
}

/**
 * How many reverse-geocodes one request may make.
 *
 * The discovery feed called `resolveEventCity` per event, so a page of 20
 * null-city rows fanned out **20 concurrent Nominatim requests** on a
 * user-facing read -- against a public API with a courtesy rate limit, from a
 * path that is polled. The cap is not a tuning knob: past it the answer is
 * null, and the card renders without a city rather than the page waiting.
 *
 * Low on purpose. A null city is a row that should have been resolved at write
 * time, so needing more than three in one page means the backfill is behind,
 * not that the cap is wrong. `resolveEventCityPersisting` writes results back,
 * so a hot page heals itself a few rows at a time.
 */
export const MAX_GEOCODES_PER_REQUEST = 3

/**
 * A per-request budget for reverse-geocoding.
 *
 * Made by the list route and passed down, rather than held module-level: a
 * module-level counter is shared by every concurrent request, so one busy page
 * would exhaust the budget for everybody else's.
 */
export function geocodeBudget(limit: number = MAX_GEOCODES_PER_REQUEST) {
  let spent = 0
  return {
    take(): boolean {
      if (spent >= limit) return false
      spent++
      return true
    },
    get exhausted() {
      return spent >= limit
    },
    get spent() {
      return spent
    },
  }
}

export type GeocodeBudget = ReturnType<typeof geocodeBudget>

export async function resolveEventCity(
  city: string | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  budget?: GeocodeBudget
): Promise<string | null> {
  const normalizedCity = await normalizeLocationToCity(city, budget)
  if (normalizedCity) return normalizedCity

  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined
  ) {
    return null
  }

  /*
   * An already-cached coordinate costs nothing, so it does not spend budget --
   * otherwise a page of twenty events at one venue would stop after three.
   */
  const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`
  if (coordinateCache.has(cacheKey)) return coordinateCache.get(cacheKey) ?? null

  if (budget && !budget.take()) return null

  return reverseGeocodeCity(latitude, longitude)
}
