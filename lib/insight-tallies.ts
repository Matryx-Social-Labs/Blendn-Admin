// Relative imports: run by the lifecycle sweeper, which server.ts reaches.
import { Prisma, type work_intent } from "@prisma/client"

import { connectionCounts, type ConnectionCounts } from "./connection-metrics"
import { db } from "./db"
import { logger } from "./logger"

/**
 * An event's insight counts, frozen before the purges take the rows behind
 * them (SCRUM-1051, step 4). The 30-day purge blanks Tonight's question answers
 * and work intent; the 180-day purge deletes Lobby posts and, by cascade, their
 * asks, which are one of the three ways a connection counts. Both purges wait
 * for an event's row here, so its post-event insights survive them.
 *
 * Raw counts, like `event_feedback_tallies`: the readers apply the floors
 * (`MIN_ATTENDEES`, `MIN_CELL`, the complement) to a frozen count exactly as to
 * a live one. Never an id, never words.
 */
export interface InsightCounts {
  connections: ConnectionCounts
  /** Live posts by kind, and asks shown to their author (a silenced ask is nobody's). */
  lobby: { offer: number; seeking: number; chat: number; asks: number; accepted: number }
  /** Tonight's question answered, and the work-intent mix (`work_intent`). */
  tonight: { answered: number; workIntent: Record<work_intent, number> }
}

/** Events frozen per pass. A pass is every 15 minutes, and a purge waits for the events it has not reached. */
export const FREEZE_BATCH = 200

const n = (v: bigint | number | null | undefined) => Number(v ?? 0)

export async function insightCountsOf(eventId: string): Promise<InsightCounts> {
  const [connections, [lobby], [tonight]] = await Promise.all([
    connectionCounts(eventId),
    // board-visibility: counts only, and a silenced ask (`silenced_at`) is left out, as it is for its author.
    db.$queryRaw<{ offer: bigint; seeking: bigint; chat: bigint; asks: bigint; accepted: bigint }[]>`
      SELECT (SELECT count(*) FROM board_posts WHERE event_id = ${eventId}::uuid AND deleted_at IS NULL AND kind = 'offer') AS offer,
             (SELECT count(*) FROM board_posts WHERE event_id = ${eventId}::uuid AND deleted_at IS NULL AND kind = 'seeking') AS seeking,
             (SELECT count(*) FROM board_posts WHERE event_id = ${eventId}::uuid AND deleted_at IS NULL AND kind = 'chat') AS chat,
             (SELECT count(*) FROM board_requests WHERE event_id = ${eventId}::uuid AND silenced_at IS NULL) AS asks,
             (SELECT count(*) FROM board_requests WHERE event_id = ${eventId}::uuid AND silenced_at IS NULL AND status = 'accepted') AS accepted`,
    db.$queryRaw<{ answered: bigint; hire: bigint; find_work: bigint; build: bigint; learn: bigint }[]>`
      SELECT count(*) FILTER (WHERE tonight_answer IS NOT NULL) AS answered,
             count(*) FILTER (WHERE work_intent = 'hire') AS hire,
             count(*) FILTER (WHERE work_intent = 'find_work') AS find_work,
             count(*) FILTER (WHERE work_intent = 'build') AS build,
             count(*) FILTER (WHERE work_intent = 'learn') AS learn
        FROM event_match_preferences WHERE event_id = ${eventId}::uuid`,
  ])
  return {
    connections,
    lobby: { offer: n(lobby?.offer), seeking: n(lobby?.seeking), chat: n(lobby?.chat), asks: n(lobby?.asks), accepted: n(lobby?.accepted) },
    tonight: {
      answered: n(tonight?.answered),
      workIntent: { hire: n(tonight?.hire), find_work: n(tonight?.find_work), build: n(tonight?.build), learn: n(tonight?.learn) },
    },
  }
}

/**
 * Freeze every event that ended before `endedBefore` and has no tally yet,
 * oldest first, `FREEZE_BATCH` at a time. Once per event: a later pass finds
 * the row and skips it. One event failing is logged and leaves no row, so the
 * purges keep waiting for it rather than taking its rows unfrozen.
 *
 * "Ended" is the calling purge's own test, so the freeze always reaches what
 * that purge would take: `everyNight` (the Tonight purge) waits for a run's
 * last night as well; the Lobby purge reads `events.end_time` alone.
 */
export async function freezeInsightTallies(endedBefore: Date, { everyNight = true }: { everyNight?: boolean } = {}): Promise<number> {
  const lastNight = everyNight
    ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM event_occurrences o WHERE o.event_id = e.id AND o.end_time >= ${endedBefore})`
    : Prisma.empty
  // any-kind: every event's rows are purged, a venue day's included, so every event is frozen first.
  const due = await db.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM events e
     WHERE e.end_time < ${endedBefore}
       ${lastNight}
       AND NOT EXISTS (SELECT 1 FROM event_insight_tallies t WHERE t.event_id = e.id)
     ORDER BY e.end_time ASC
     LIMIT ${FREEZE_BATCH}`
  let frozen = 0
  for (const { id } of due) {
    try {
      const counts = await insightCountsOf(id)
      await db.event_insight_tallies.createMany({ data: [{ event_id: id, counts: counts as never }], skipDuplicates: true })
      frozen++
    } catch (error) {
      logger.error("Insight tally not frozen; its purges wait for the next pass", { eventId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return frozen
}
