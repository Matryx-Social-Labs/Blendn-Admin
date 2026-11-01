import type { Prisma } from "@prisma/client"

import { db } from "./db"
import { MIN_CELL, RATING_BATCH, type RatingGroupRow } from "./disclosure"

/**
 * Every host-side read of scores, as `groupBy(["event_id", "rating"])` rows: each event's published raters only
 * (`publishedRaters`, oldest first), so a reload as ratings arrive cannot read the newest score from the bars
 * (SCRUM-472, owner row A-7). Hand them to `spreadsByEventId` and the `discloseStars` family as before.
 *
 * ponytail: a rater who edits their score after being published still moves a bar. A frozen snapshot per batch closes
 * that; add it if ratings ever become editable in the app's flow past the first submit.
 */
export async function publishedRatingGroups(events: Prisma.eventsWhereInput): Promise<RatingGroupRow[]> {
  // any-kind: the caller's scope decides which events; a venue day that is rated is rated.
  const rated = await db.events.findMany({ where: { ...events, ratings: { some: {} } }, select: { id: true } })
  if (rated.length === 0) return []
  const rows = await db.$queryRaw<{ event_id: string; rating: number; n: number }[]>`
    SELECT event_id, rating, count(*)::int AS n
      FROM (
        SELECT event_id, rating,
               row_number() OVER (PARTITION BY event_id ORDER BY created_at, id) AS nth,
               count(*) OVER (PARTITION BY event_id) AS raters
          FROM event_ratings
         WHERE event_id = ANY(${rated.map((e) => e.id)}::uuid[])
      ) r
     WHERE nth <= CASE WHEN raters < ${MIN_CELL}::int THEN raters
                       ELSE ${MIN_CELL}::int + ((raters - ${MIN_CELL}::int) / ${RATING_BATCH}::int) * ${RATING_BATCH}::int END
     GROUP BY event_id, rating`
  return rows.map((r) => ({ event_id: r.event_id, rating: r.rating, _count: { _all: r.n } }))
}
