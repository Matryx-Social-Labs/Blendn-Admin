import { createHash } from "node:crypto"

import { cityKey } from "@/lib/address"

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
  /** 1-based, in the day's rotation (`rotated`), among the featured events in the same response. */
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
 * The seed of the daily rotation: the day and the city, so every viewer of one
 * city sees one order on one day, and it changes at the day's turn.
 * ponytail: the UTC day (Bengaluru's turns at 05:30 IST); a city's own zone if
 * the turn ever has to land at its midnight.
 */
export function featuredSeed(city: string | undefined, now: Date): string {
  return `${now.toISOString().slice(0, 10)}|${cityKey(city)}`
}

/**
 * The events in the day's rotation order: by a hash of seed and id, so which
 * five of a larger set lead is stable for everybody all day and different
 * tomorrow. Ties (a hash collision) fall to the id.
 * ponytail: nothing balances impressions between paid placements yet (C2); when
 * `promoted` exists it sorts before editorial here, and rotates within itself.
 */
export function rotated<T extends { id: string }>(events: readonly T[], seed: string): T[] {
  const key = (e: T) => createHash("sha1").update(`${seed}|${e.id}`).digest("hex")
  return events
    .map((e) => ({ e, k: key(e) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.e.id < b.e.id ? -1 : 1))
    .map(({ e }) => e)
}

/**
 * `featured` for each event, by id. Rank is the position in the day's rotation
 * (`rotated`) among the featured events given: for `featured=true`, which
 * returns the section, it is the order of the cards; on an ordinary page it is
 * the order within that page.
 */
export function featuredOf(
  events: ReadonlyArray<{ id: string; is_featured: boolean }>,
  seed: string
): Map<string, Featured> {
  const featured = rotated(
    events.filter((e) => featuredKind(e) !== null),
    seed
  )
  return new Map(
    featured.map((e, i) => [e.id, { kind: featuredKind(e)!, rank: i + 1, by: EDITORIAL_BY }])
  )
}
