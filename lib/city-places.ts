import { db } from "./db"
import { openOnBlendnWhere } from "./venue-visibility"

const CITY_PLACES_TTL_MS = 60 * 1000

type PlacePoint = { city: string | null; latitude: number | null; longitude: number | null }

type Cached = { expiresAt: number; places: Promise<PlacePoint[]> } | null
// On globalThis like the live-count and open-tonight caches: Next bundles its own copy of a lib per layer.
const shared = globalThis as typeof globalThis & { __blendnCityPlaces?: Cached }

/**
 * Every listed place's city and point: the input to the city picker's
 * `placeCount` and map centre.
 *
 * The same for every viewer, so one scan serves them all. On staging it is
 * 6,452 rows and about 143 kB of city text read and shipped to Node on every
 * picker open, to be grouped in JS (5.7 ms for 6.4k rows, 51.8 ms for 64k,
 * measured locally); the picker is the first thing a new install opens.
 *
 * The promise is cached, not the rows, so concurrent opens share one scan; a
 * failed scan is dropped so the next request retries.
 *
 * ponytail: stale for up to 60 s after a venue is added, hidden or renamed, so
 * a picker count can be a minute behind the Places list. In-process, per
 * instance; move to SQL grouping or Redis if the table outgrows a scan.
 */
export function cityPlaces(): Promise<PlacePoint[]> {
  const now = Date.now()
  const cached = shared.__blendnCityPlaces
  if (cached && cached.expiresAt > now) return cached.places
  const places = db.venues
    .findMany({
      where: { deleted_at: null, status: "active", city: { not: null }, AND: [openOnBlendnWhere] },
      select: { city: true, latitude: true, longitude: true },
    })
    .catch((error) => {
      // Only if the cache still holds this scan; a newer one is not ours to drop.
      if (shared.__blendnCityPlaces?.places === places) shared.__blendnCityPlaces = null
      throw error
    })
  shared.__blendnCityPlaces = { expiresAt: now + CITY_PLACES_TTL_MS, places }
  return places
}
