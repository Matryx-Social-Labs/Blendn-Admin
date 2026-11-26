import { cityFrom, type NominatimAddress } from "./address"
import { logger } from "./logger"

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

/**
 * A stored location as a read returns it (SCRUM-1229): the text, or null while
 * it is still coordinates. A read never geocodes -- that cost up to 3.5 s per
 * user read against a public API with a 1 req/s policy -- and never shows the
 * coordinates either: a profile other people fetch must not say where somebody
 * was standing. The client already renders a missing city.
 */
export function storedCity(location: string | null | undefined): string | null {
  const trimmed = location?.trim()
  if (!trimmed || parseCoordinateLocation(trimmed)) return null
  return trimmed
}

/**
 * Reverse-geocodes on a write only. Null when Nominatim fails or has no city;
 * nothing is remembered, so the next write asks again rather than a failure
 * hiding a city until the next deploy.
 */
export async function reverseGeocodeCity(
  lat: number,
  lon: number
): Promise<string | null> {
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
        signal: AbortSignal.timeout(3500),
      }
    )
    if (!response.ok) {
      // An error, so it reaches Sentry: a sustained refusal (403/429: blocked under the usage policy) means no write gets a city.
      logger.error("Reverse geocode refused", { status: response.status })
      return null
    }
    const data = (await response.json()) as { address?: NominatimAddress }
    return cityFrom(data.address)
  } catch (error) {
    logger.error("Reverse geocode failed", { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * What a profile write stores for `location`: the text as typed, the city at
 * coordinates, null to clear, or undefined to leave the column alone -- when
 * nothing was sent, or when the coordinates could not be geocoded, so a failed
 * lookup never writes null over a city that was there.
 */
export async function locationToStore(
  location: string | null | undefined
): Promise<string | null | undefined> {
  if (location === undefined) return undefined
  const trimmed = location?.trim()
  if (!trimmed) return null
  const coordinates = parseCoordinateLocation(trimmed)
  if (!coordinates) return trimmed
  return (await reverseGeocodeCity(coordinates.lat, coordinates.lon)) ?? undefined
}

/**
 * An event's city on create, or on an edit that moves the pin: the city typed,
 * else the city at coordinates typed as `city`, else the city at the pin. Null
 * when none gives one; the edit route then keeps the stored city.
 */
export async function resolveEventCity(
  city: string | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined
): Promise<string | null> {
  const typed = storedCity(city)
  if (typed) return typed
  const typedCoordinates = city ? parseCoordinateLocation(city) : null
  const fromTyped = typedCoordinates ? await reverseGeocodeCity(typedCoordinates.lat, typedCoordinates.lon) : null
  if (fromTyped || latitude == null || longitude == null) return fromTyped
  return reverseGeocodeCity(latitude, longitude)
}
