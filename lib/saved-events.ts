import { db } from "./db"
import { realEventsWhere } from "./event-kind"

/**
 * Which saved events the saved list shows: `upcoming` (the default) or `past`.
 * A draft is invisible everywhere else on the product, and a deleted event is
 * gone; cancelled and completed stay, as history.
 *
 * One definition for the list (`GET /users/:id/favorites`) and the count on
 * Me (`stats.savedCount`), because a count that reads a wider where than the
 * list it opens is how Me said 9 over a list of 6 (SCRUM-825).
 */
export function savedEventWhere(timeFilter: string, now: Date) {
  return {
    deleted_at: null,
    ...realEventsWhere,
    status: { not: "draft" as const },
    ...(timeFilter === "past" ? { end_time: { lt: now } } : { end_time: { gte: now } }),
  }
}

/** How many events the viewer's default (upcoming) saved list holds. */
export function savedCount(userId: string, now = new Date()): Promise<number> {
  return db.event_favorites.count({ where: { user_id: userId, event: savedEventWhere("upcoming", now) } })
}
