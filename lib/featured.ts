/**
 * What "featured" means on an event card, as the app reads it.
 *
 * `featured: { kind, rank, by } | null` on every item of `GET /api/mobile/events`;
 * `isFeatured` stays beside it for builds that predate it.
 *
 * `kind` is `editorial` (Blendn's own pick, `events.is_featured`, set by an
 * admin; carries no label in the app, `by` is `"blendn"`) or `promoted` (a paid
 * placement, always labelled "Promoted"). Nothing sells a placement yet, so
 * nothing produces `promoted`: it is in the type so a client that switches on
 * `kind` already handles it, and `featuredKind` below is the one place that
 * will learn it. `by` is who placed it: `"blendn"` for an editorial pick, and
 * for a promotion the placing organisation's name.
 */
export type FeaturedKind = "editorial" | "promoted"

export interface Featured {
  kind: FeaturedKind
  /** 1-based, by start time, among the featured events in the same response. */
  rank: number
  by: string | null
}

/** `featured=true` returns at most this many events. */
export const FEATURED_MAX = 5

export const EDITORIAL_BY = "blendn"

/** The kind an event is featured as, or null when it is not featured. */
export function featuredKind(event: { is_featured: boolean }): FeaturedKind | null {
  return event.is_featured ? "editorial" : null
}

/**
 * `featured` for each event, by id. Rank is the position by start time (id as
 * the tiebreak) among the featured events given, so for `featured=true`, which
 * returns the whole set, it is the order of the section; on an ordinary page it
 * is the order within that page.
 */
export function featuredOf(
  events: ReadonlyArray<{ id: string; start_time: Date; is_featured: boolean }>
): Map<string, Featured> {
  const featured = events
    .filter((e) => featuredKind(e) !== null)
    .sort((a, b) => a.start_time.getTime() - b.start_time.getTime() || (a.id < b.id ? -1 : 1))
  return new Map(
    featured.map((e, i) => [e.id, { kind: featuredKind(e)!, rank: i + 1, by: EDITORIAL_BY }])
  )
}
