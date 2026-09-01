// Relative, not "@/lib/db". `build:server` compiles this with plain tsc,
// which resolves the @/ alias for typechecking and then emits it verbatim into
// the require() — so the build goes green and the container dies on boot with
// MODULE_NOT_FOUND. Everything reachable from server.ts must use relative
// paths.
import { db } from "./db"
import { occupancyFrom } from "./occupancy"
import { escalates } from "./sentiment/taxonomy"
import { resolveOccurrence } from "./occurrences"

import type { LiveSnapshot } from "./live-metrics"

const MINUTE = 60 * 1000

/**
 * How many ten-minute slots with an arrival before there is a baseline.
 *
 * With one or two, the baseline *is* the opening rush, so every event would
 * trip the entry alert on its own second bucket. Three is the smallest number
 * from which "typical" means anything, and until then `medianRate10m` is 0 and
 * the alert stays silent — which is the correct answer for the first half hour
 * of an event, where a queue is expected.
 */
const MIN_BUCKETS_FOR_BASELINE = 3

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
  /*
   * Which day it is, resolved once, exactly as `getOccupancy` does.
   *
   * Every count below was event-wide, so on day two of a run *every day-one row
   * was already checked out* -- and `leaving_early` compares
   * checkedOut/checkedIn against 0.25, which meant it fired at doors on the
   * second morning of every multi-day event and stayed on. An alert that is
   * always on is an alert nobody reads, and it sits beside the safety one.
   *
   * `inside` had the mirror of the same problem: a day-one attendee the sweeper
   * missed is still `checked_in` and was counted as in the building on day
   * three.
   *
   * Falls back to event-wide when nothing resolves, which is identical for a
   * single-day event and is the honest answer for an event between days.
   */
  const slot = await resolveOccurrence(eventId, now)
  const today = slot.occurrence ? { occurrence_id: slot.occurrence.id } : {}

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
      where: { event_id: eventId, status: { in: ["checked_in", "checked_out"] }, ...today },
    }),
    db.event_check_ins.count({
      where: { event_id: eventId, check_out_time: { not: null }, ...today },
    }),
    db.event_check_ins.count({
      where: { event_id: eventId, status: "checked_in", kind: "staff", ...today },
    }),
    db.event_check_ins.count({
      where: { event_id: eventId, check_in_time: { gte: tenMinutesAgo }, ...today },
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
    /*
     * The occurrence's capacity, not the event's.
     *
     * This read `event.max_capacity` while `getOccupancy` resolved a
     * per-occurrence one, so the live tab and the occupancy panel reported
     * different fills for the same room -- the exact "two screens, one room, two
     * answers" the comment six lines up says the shared module prevents. It
     * prevented the arithmetic diverging and not the input.
     */
    capacity: slot.occurrence?.capacity ?? event.max_capacity,
  })

  /*
   * Median of every completed 10-minute bucket since doors. The rate alone says
   * nothing — 31 arrivals is a stampede for a book club and a slow night for a
   * festival — so the alert compares against this event's own baseline.
   */
  /*
   * The baseline the entry alert compares against: a typical **busy** ten
   * minutes, not a typical ten minutes.
   *
   * This used to densify the sparse `GROUP BY` back into every completed slot
   * since doors, on the reasoning that "a quiet hour is baseline information
   * and dropping its zeros would raise the median and make the alert
   * progressively harder to fire".
   *
   * That is backwards, and it disabled the alert outright. Arrivals cluster
   * hard at the start, so most slots of an evening are zero — the median of a
   * mostly-zero series is **zero**, and `deriveAlerts` guards on
   * `medianRate10m > 0`. It was the zeros that made it unfireable, and they got
   * more effective as the night went on.
   *
   * The question the alert is asking is "is the door struggling right now",
   * and an empty slot says nothing about how fast the door can move — it says
   * nobody was arriving. So the baseline is the median over slots that had an
   * arrival.
   *
   * At least three of them before it means anything: with one or two, the
   * baseline is the opening rush itself, and every event would trip on its own
   * second bucket.
   */
  const busyBuckets = arrivalBuckets
    .map((row) => Number(row.n))
    .filter((n) => n > 0)
  const buckets = busyBuckets.length >= MIN_BUCKETS_FOR_BASELINE ? busyBuckets : []

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

