// Relative, not "@/lib/db". `build:server` compiles this with plain tsc,
// which resolves the @/ alias for typechecking and then emits it verbatim into
// the require() — so the build goes green and the container dies on boot with
// MODULE_NOT_FOUND. Everything reachable from server.ts must use relative
// paths.
import { db } from "./db"
import { occupancyFrom } from "./occupancy"
import { escalates } from "./sentiment/taxonomy"

import type { LiveSnapshot } from "./live-metrics"

const MINUTE = 60 * 1000

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Compute one snapshot.
 *
 * Read directly rather than kept in memory: a counter held in the process is
 * wrong after any restart, and wrong in a way nobody notices until an alert
 * fails to fire. The queries are all indexed and scoped to one event.
 */
export async function buildLiveSnapshot(eventId: string): Promise<LiveSnapshot | null> {
  const now = new Date()
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      start_time: true,
      // Bounds the arrival histogram. Without it the series extended past the
      // event forever, appending empty buckets and dragging the median down.
      end_time: true,
      max_capacity: true,
      chat_group: { select: { id: true } },
    },
  })
  if (!event) return null

  const tenMinutesAgo = new Date(now.getTime() - 10 * MINUTE)
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * MINUTE)
  const chatGroupId = event.chat_group?.id

  /*
   * Counts, not rows.
   *
   * This used to be an unbounded `findMany` over every check-in for the event,
   * followed by five JS `.filter()` passes and a histogram loop. It runs on a
   * 5-second interval (`lib/socket-server.ts` ops broadcast) on the same event
   * loop as Socket.io, so on day three of a three-day, three-thousand-person
   * festival it pulled 3,000 rows off the wire twelve times a minute and did
   * over a million date comparisons per minute — degrading precisely at the
   * largest events, with chat delivery queued behind it.
   *
   * The database answers all of it. Same pattern as `lib/occupancy.ts:121-127`.
   */
  const [
    checkedInTotal,
    checkedOutTotal,
    staffInside,
    checkInRate10m,
    arrivalBuckets,
    recentMessages,
    activeChatters,
    openFlags,
    feedback,
  ] = await Promise.all([
    db.event_check_ins.count({
      where: { event_id: eventId, status: { in: ["checked_in", "checked_out"] } },
    }),
    db.event_check_ins.count({
      where: { event_id: eventId, check_out_time: { not: null } },
    }),
    db.event_check_ins.count({
      where: { event_id: eventId, status: "checked_in", kind: "staff" },
    }),
    db.event_check_ins.count({
      where: { event_id: eventId, check_in_time: { gte: tenMinutesAgo } },
    }),
    /*
     * The arrival histogram, bucketed by Postgres rather than by a loop.
     *
     * Bounded by `min(now, end_time)`: the loop was bounded by `now` alone, so
     * after an event ended it kept extending the window and appending empty
     * buckets forever, dragging the median toward zero and making the
     * arrival-rate alert progressively less able to fire.
     */
    db.$queryRaw<Array<{ bucket: Date; n: bigint }>>`
      SELECT to_timestamp(floor(extract(epoch FROM check_in_time) / 600) * 600) AS bucket,
             count(*) AS n
        FROM event_check_ins
       WHERE event_id = ${eventId}::uuid
         AND check_in_time IS NOT NULL
         AND check_in_time >= ${event.start_time}
         AND check_in_time < ${new Date(Math.min(now.getTime(), event.end_time.getTime()))}
    GROUP BY 1
    ORDER BY 1
    `,
    chatGroupId
      ? db.chat_messages.count({
          where: {
            chat_group_id: chatGroupId,
            deleted_at: null,
            created_at: { gte: tenMinutesAgo },
          },
        })
      : Promise.resolve(0),
    chatGroupId
      ? db.chat_messages
          .findMany({
            where: {
              chat_group_id: chatGroupId,
              deleted_at: null,
              created_at: { gte: thirtyMinutesAgo },
            },
            select: { user_id: true },
            distinct: ["user_id"],
          })
          .then((rows) => rows.length)
      : Promise.resolve(0),
    chatGroupId
      ? db.moderation_flags.count({ where: { chat_group_id: chatGroupId, status: "pending" } })
      : Promise.resolve(0),
    db.event_feedback.findMany({
      where: { event_id: eventId, created_at: { gte: thirtyMinutesAgo } },
      select: { sentiment: true, category: true },
    }),
  ])

  const inside = Math.max(0, checkedInTotal - checkedOutTotal)

  /*
   * Shared with `getOccupancy`, not recomputed. This screen used to cap fill at
   * 100% and measure it against staff-inclusive occupancy, while the occupancy
   * panel measured guests and reported the breach — so the same room read "full"
   * here and "110%, 8 over" there. The rows are already in memory; only the
   * arithmetic is borrowed.
   */
  const occupancy = occupancyFrom({
    inside,
    staffInside,
    // Not surfaced on the live tab — attendance is the Overview's question.
    uniqueAttendance: 0,
    capacity: event.max_capacity,
  })

  /*
   * Median of every completed 10-minute bucket since doors. The rate alone says
   * nothing — 31 arrivals is a stampede for a book club and a slow night for a
   * festival — so the alert compares against this event's own baseline.
   */
  /*
   * Empty buckets are counted, and that is not incidental.
   *
   * The `GROUP BY` returns only slots that had an arrival, but the median has
   * to be taken over EVERY completed slot since doors — a quiet hour is
   * baseline information, and dropping its zeros would raise the median and
   * make the arrival-rate alert progressively harder to fire. So the sparse
   * result is expanded back into a dense series here.
   *
   * The end bound is `min(now, end_time)`, where the old loop used `now`
   * alone: after an event finished it kept appending empty buckets forever,
   * dragging the median to zero.
   */
  const arrivalsByBucket = new Map(
    arrivalBuckets.map((row) => [row.bucket.getTime(), Number(row.n)])
  )
  const buckets: number[] = []
  const doors = event.start_time
  const lastTick = Math.min(now.getTime(), event.end_time.getTime())
  for (let t = doors.getTime(); t + 10 * MINUTE <= lastTick; t += 10 * MINUTE) {
    // Align to the same 600-second floor the query bucketed on.
    const slot = Math.floor(t / (10 * MINUTE)) * (10 * MINUTE)
    buckets.push(arrivalsByBucket.get(slot) ?? 0)
  }

  const sentiment = { positive: 0, neutral: 0, negative: 0 }
  const categoryCounts = new Map<string, number>()
  for (const row of feedback) {
    sentiment[row.sentiment] += 1
    // Only what needs attention: positives by category are noise on a live
    // screen whose job is surfacing problems. The escalating set is asked for
    // by name rather than spelled `=== "safety_conduct"` inline: the literal
    // was copied into four files, so the day a second category escalates,
    // three of them keep the old answer and nobody finds out.
    if (row.sentiment === "negative" || escalates(row.category)) {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
    }
  }

  return {
    eventId,
    at: now.toISOString(),
    inside: occupancy.inside,
    guestsInside: occupancy.guestsInside,
    staffInside: occupancy.staffInside,
    checkedInTotal,
    checkedOutTotal,
    capacity: occupancy.capacity,
    fillPct: occupancy.fillPct,
    overCapacity: occupancy.overCapacity,
    checkInRate10m,
    medianRate10m: median(buckets),
    messagesPerMinute: Math.round((recentMessages / 10) * 10) / 10,
    activeChatters30m: activeChatters,
    openFlags,
    sentiment,
    categories: Array.from(categoryCounts.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
  }
}

