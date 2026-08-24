import { cityKey } from "./address"

/**
 * The cache key for a page of `GET /api/mobile/events`.
 *
 * Lives here rather than in the route so it can be tested: the failure mode is
 * an input that changes the result set and is *missing* from the key, and that
 * is invisible by inspection — the cache simply serves one user's results to
 * another and nothing errors.
 *
 * ## `viewerAge` was missing, and it mattered
 *
 * The list filters on `min_age <= viewer.age` when the age is known, but the
 * key mentioned neither age nor user. So an adult's request cached a list
 * containing 18+ events, and any request matching that key inside the
 * 30-second TTL was served it — including a minor's.
 *
 * Discovery-only: check-in still refuses at the door, which is the deliberate
 * split described on the age filter itself. But an age-gated listing that is
 * not age-gated in practice, in a product with dating intent, is not something
 * to leave standing.
 *
 * Keyed on the **age**, not the user id. Two 24-year-olds see the same events
 * and should share an entry; keying per user would empty the cache of value at
 * exactly the moment it is doing work.
 *
 * Pinned by __tests__/events-cache-key.test.ts.
 */
export interface EventsCacheKeyInput {
  page: number
  limit: number
  search?: string
  city?: string
  /** `null` when the viewer has no age on file — itself a distinct result set. */
  viewerAge: number | null
  lat?: number
  lon?: number
  radius?: number
  categoryId?: string
  categorySlug?: string
  startDate?: string
  endDate?: string
  includePast?: boolean
  status?: string
  sortBy: string
  sortOrder: string
}

export function buildEventsCacheKey(input: EventsCacheKeyInput): string {
  return JSON.stringify({
    page: input.page,
    limit: input.limit,
    search: input.search || null,
    // Normalised the same way the filter matches, so "Bengaluru" and
    // "bengaluru" share an entry instead of caching the same list twice.
    city: cityKey(input.city) || null,
    viewerAge: input.viewerAge,
    /*
     * Coordinates only enter the key when they change the query.
     *
     * They used to always. The client sends a raw GPS fix on every feed
     * request, and a fix jitters in the sixth decimal place between readings —
     * so every request from every device produced a unique key, missed, and
     * then FIFO-evicted one of the hundred slots, including the coordinate-free
     * entries that would otherwise have hit. The cache did close to no work
     * while costing a `JSON.stringify` of a seventeen-field object per request.
     *
     * `lat`/`lon` only change the `where` clause when `radius` is set, and only
     * change the ordering when sorting by distance. Everywhere else they are
     * used *after* the cache, to label each row with a distance — so two
     * callers standing ten metres apart genuinely want the same cached list.
     */
    ...(input.radius !== undefined || input.sortBy === "distance"
      ? { lat: input.lat ?? null, lon: input.lon ?? null }
      : { lat: null, lon: null }),
    radius: input.radius ?? null,
    categoryId: input.categoryId || null,
    categorySlug: input.categorySlug || null,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    includePast: input.includePast,
    status: input.status || null,
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
  })
}
