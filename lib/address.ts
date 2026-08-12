/**
 * One reading of a geocoder response.
 *
 * The same question — "which city is this pin in?" — was answered in three
 * places with three different answers:
 *
 *   - `lib/location.ts`    city→town→village→municipality→county→state_district→state
 *   - `location-picker.tsx`  city→town→village→municipality
 *   - `venue-create-form.tsx`  city→town→**state_district**
 *
 * So a pin in a village came back as the village from the event form and as
 * *"Bangalore Rural"* from the venue form, and the same place ended up in the
 * database under two names depending on which screen the organiser happened to
 * use. That fragments a city picker at the source: each spelling finds half the
 * events and neither looks wrong on its own.
 *
 * Nominatim itself is consistent — it returns one canonical name per OSM
 * entity, so two organisers pinning the same place get the same string. The
 * divergence was ours.
 *
 * ## Why `city` first matters more than it looks
 *
 * A pin in Whitefield returns `suburb: "Whitefield"` *and* `city: "Bengaluru"`,
 * because Whitefield sits inside BBMP limits. Preferring `city` is what stops
 * one city's events splitting across a dozen neighbourhood names. `suburb` and
 * `neighbourhood` are deliberately not in the chain at all.
 *
 * A genuinely separate town nearby has no `city` key and returns
 * `town: "Anekal"` — correctly a different place, not a suburb of anything.
 *
 * ## The tail is a ceiling, not a preference
 *
 * `county`, `state_district` and `state` are administrative regions, not
 * settlements. Falling through to them means the geocoder could not name a
 * settlement, and "Karnataka" will read oddly in a city picker. It is still
 * better than `null`, which makes an event unreachable from every city scope.
 * If region-level values start showing up in the picker, the fix is a
 * settlement-level lookup, not a longer chain.
 *
 * Pinned by __tests__/address.test.ts.
 */

/** The address block Nominatim returns under `addressdetails=1`. */
export type NominatimAddress = Record<string, string | undefined>

export interface ResolvedAddress {
  /** Full street address, as the geocoder writes it. */
  address: string
  city: string | null
  state: string | null
  country: string | null
  postalCode: string | null
}

/**
 * Settlement first, region only as a last resort. See the file header.
 *
 * Order is the whole contract here, so it lives in one array rather than a
 * chain of `||` that is easy to reorder by accident when editing.
 */
const CITY_KEYS = [
  "city",
  "town",
  "village",
  "municipality",
  // Region-level fallbacks — reached only when no settlement was named.
  "county",
  "state_district",
  "state",
] as const

export function cityFrom(address: NominatimAddress | undefined): string | null {
  if (!address) return null
  for (const key of CITY_KEYS) {
    const value = address[key]?.trim()
    if (value) return value
  }
  return null
}

/**
 * Read a whole address out of a geocoder result.
 *
 * `lat`/`lng` are the fallback for `address` so the caller always has something
 * to show: coordinates are a poor address and an honest one, where an empty
 * string reads as "this event has no location".
 */
export function extractAddress(
  lat: number,
  lng: number,
  result?: { display_name?: string; address?: NominatimAddress }
): ResolvedAddress {
  const address = result?.address
  return {
    address: result?.display_name?.trim() || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    city: cityFrom(address),
    state: address?.state?.trim() || address?.region?.trim() || null,
    country: address?.country?.trim() || null,
    postalCode: address?.postcode?.trim() || null,
  }
}

/**
 * Compare two city names the way a human would.
 *
 * Insurance for rows written before this module existed: `"bengaluru "` and
 * `"Bengaluru"` are the same place and must group as one in the picker. It
 * deliberately does **not** map aliases — "Bangalore" and "Bengaluru" stay
 * distinct, because guessing at synonyms silently merges places that are
 * genuinely different (there are two Springfields in most countries).
 */
export function cityKey(city: string | null | undefined): string {
  return city?.trim().toLowerCase() ?? ""
}

export interface CityCount {
  city: string
  eventCount: number
}

/**
 * Fold a column of city names into the list a picker can show.
 *
 * Lives here rather than in the route so it can be tested without a database —
 * the grouping rules are where the bugs are, not the query.
 *
 * Two decisions worth stating:
 *
 * **The label is the spelling seen most often**, not the first one. "First"
 * would rename a whole city in the picker the moment one event was deleted,
 * which looks like data loss to anyone watching.
 *
 * **Busiest first, alphabetical within a tie.** The list is a menu, so the city
 * most people want should be at the top; the tiebreak exists because Postgres
 * returns rows in no particular order, and without it two loads of the same
 * screen could show the same cities in different positions.
 */
export function groupCities(cities: readonly (string | null)[]): CityCount[] {
  const buckets = new Map<string, { labels: Map<string, number>; count: number }>()

  for (const raw of cities) {
    const key = cityKey(raw)
    if (!key) continue
    const label = raw!.trim()
    const bucket = buckets.get(key) ?? { labels: new Map<string, number>(), count: 0 }
    bucket.count += 1
    bucket.labels.set(label, (bucket.labels.get(label) ?? 0) + 1)
    buckets.set(key, bucket)
  }

  return [...buckets.values()]
    .map((bucket) => ({
      city: [...bucket.labels.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0][0],
      eventCount: bucket.count,
    }))
    .sort((a, b) => b.eventCount - a.eventCount || a.city.localeCompare(b.city))
}
