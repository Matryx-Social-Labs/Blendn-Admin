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

    const data = (await response.json()) as {
      address?: Record<string, string | undefined>
    }
    const address = data.address
    const city =
      address?.city ||
      address?.town ||
      address?.village ||
      address?.municipality ||
      address?.county ||
      address?.state_district ||
      address?.state ||
      null

    const normalized = city?.trim() || null
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
  location: string | null | undefined
): Promise<string | null> {
  if (!location) return null
  const trimmed = location.trim()
  if (!trimmed) return null

  const coordinates = parseCoordinateLocation(trimmed)
  if (!coordinates) return trimmed

  const city = await reverseGeocodeCity(coordinates.lat, coordinates.lon)
  return city
}

export async function resolveEventCity(
  city: string | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined
): Promise<string | null> {
  const normalizedCity = await normalizeLocationToCity(city)
  if (normalizedCity) return normalizedCity

  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined
  ) {
    return null
  }

  return reverseGeocodeCity(latitude, longitude)
}
