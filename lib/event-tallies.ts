import { db } from "./db"

export interface EventTallies {
  favorites: Map<string, number>
  ratings: Map<string, number>
  /** RSVPs `going` only: never waitlisted, maybe or not_going. */
  going: Map<string, number>
}

/**
 * Favourites, ratings and going-RSVPs for these events: one indexed GROUP BY
 * each, restricted to the ids on the page.
 *
 * This replaces a Prisma relation `_count`, which is emitted as
 * `LEFT JOIN (SELECT event_id, COUNT(*) FROM event_favorites GROUP BY event_id)`
 * with no restriction to the page: staging's plan was a Seq Scan plus
 * HashAggregate over all of event_rsvps (728 rows), event_favorites (219) and
 * event_ratings (55) to return 18 events. That grows with the table, not the
 * page. Absent rather than zero for an event with none; callers read `?? 0`.
 */
export async function eventTallies(eventIds: readonly string[]): Promise<EventTallies> {
  if (eventIds.length === 0) {
    return { favorites: new Map(), ratings: new Map(), going: new Map() }
  }
  const where = { event_id: { in: [...eventIds] } }
  const [favorites, ratings, going] = await Promise.all([
    db.event_favorites.groupBy({ by: ["event_id"], where, _count: true }),
    db.event_ratings.groupBy({ by: ["event_id"], where, _count: true }),
    db.event_rsvps.groupBy({ by: ["event_id"], where: { ...where, status: "going" }, _count: true }),
  ])
  const byEvent = (rows: { event_id: string; _count: number }[]) =>
    new Map(rows.map((r) => [r.event_id, r._count]))
  return { favorites: byEvent(favorites), ratings: byEvent(ratings), going: byEvent(going) }
}
