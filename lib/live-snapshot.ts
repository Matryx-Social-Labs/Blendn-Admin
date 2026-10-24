// Relative, not "@/lib/db". `build:server` compiles this with plain tsc,
// which resolves the @/ alias for typechecking and then emits it verbatim into
// the require() — so the build goes green and the container dies on boot with
// MODULE_NOT_FOUND. Everything reachable from server.ts must use relative
// paths.
import { db } from "./db"
import { occupancyFrom } from "./occupancy"
import { headcount } from "./presence-sessions"
import { escalates } from "./sentiment/taxonomy"
import { pickOccurrence, resolveOccurrence, type OccurrenceSlot } from "./occurrences"

import { deriveAlerts, type LiveFigures, type LiveSnapshot } from "./live-metrics"

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

/** What a snapshot reads about the event itself, and what the issue sweep needs of it afterwards. */
interface EventRead {
  id: string
  start_time: Date
  end_time: Date
  max_capacity: number | null
  chat_group: { id: string } | null
}

/**
 * The event and its days, held by a loop that builds a snapshot every few
 * seconds. Nothing in it moves during a night except an organiser's edit, and
 * that is picked up within `HELD_EVENT_MS`; re-reading it every five seconds
 * was two sequential waves out of four.
 */
export interface HeldEvent {
  readAt: number
  event: EventRead
  slots: OccurrenceSlot[]
}

export const HELD_EVENT_MS = 60_000

/** The event and its days: from `held` while it is fresh, else read (and `held` refreshed). */
async function eventAndSlots(eventId: string, now: Date, held?: { current?: HeldEvent }): Promise<{ event: EventRead; slots: OccurrenceSlot[] } | null> {
  if (held?.current && now.getTime() - held.current.readAt < HELD_EVENT_MS) return held.current
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
  const { slots } = await resolveOccurrence(eventId, now)
  if (held) held.current = { readAt: now.getTime(), event, slots }
  return { event, slots }
}

/**
 * Compute one snapshot.
 *
 * Read directly rather than kept in memory: a counter held in the process is
 * wrong after any restart, and wrong in a way nobody notices until an alert
 * fails to fire. The queries are all indexed and scoped to one event.
 *
 * `held` is the event and its days a loop keeps between ticks (`HeldEvent`);
 * leave it out for a snapshot that must read them fresh.
 */
export async function buildLiveSnapshot(eventId: string, held?: { current?: HeldEvent }): Promise<LiveSnapshot | null> {
  return (await readLiveSnapshot(eventId, held))?.snapshot ?? null
}

/** `buildLiveSnapshot`, and the event and day it read: the issue sweep needs both and must not read them twice. */
export async function readLiveSnapshot(
  eventId: string,
  held?: { current?: HeldEvent }
): Promise<{ snapshot: LiveSnapshot; event: { start_time: Date; end_time: Date }; occurrenceId: string | null } | null> {
  const now = new Date()
  const read = await eventAndSlots(eventId, now, held)
  if (!read) return null
  const { event, slots } = read

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
  const slot = pickOccurrence(slots, now)

  const [
    live,
    arrivalBuckets,
    [chat],
    openFlags,
    feedback,
  ] = await Promise.all([
    /*
     * One query where there were four.
     *
     * This screen refreshes every five seconds per watched event, and these
     * counts differ only by predicate — so Postgres computes all of them in a
     * single pass over one index rather than four round trips on the socket
     * server's event loop.
     */
    headcount(slot.occurrence ? { occurrenceId: slot.occurrence.id } : { eventId }, {
      now,
      recentMinutes: 10,
    }),
    /*
     * The arrival histogram, bucketed by Postgres rather than by a loop.
     *
     * Bounded by `min(now, end_time)`: the loop was bounded by `now` alone, so
     * after an event ended it kept extending the window and appending empty
     * buckets forever, dragging the median toward zero and making the
     * arrival-rate alert progressively less able to fire.
     */
    /*
     * Bucketed on each person's FIRST arrival, not on every session.
     *
     * Sessions make re-entry a new row by design, so counting rows here would
     * turn one person stepping out for a cigarette and coming back into a
     * second arrival — and the entry alert reads this curve to decide whether
     * a queue is building at the door.
     */
    db.$queryRaw<Array<{ bucket: Date; n: bigint }>>`
      WITH first_arrival AS (
        SELECT user_id, MIN(arrived_at) AS at
          FROM presence_sessions
         WHERE event_id = ${eventId}::uuid
      GROUP BY user_id
      )
      SELECT to_timestamp(floor(extract(epoch FROM at) / 600) * 600) AS bucket,
             count(*) AS n
        FROM first_arrival
       WHERE at >= ${event.start_time}
         AND at < ${new Date(Math.min(now.getTime(), event.end_time.getTime()))}
    GROUP BY 1
    ORDER BY 1
    `,
    /*
     * Counted in the database: the last ten minutes' messages and the distinct
     * senders of the last thirty. The senders used to be a `distinct` findMany,
     * which Prisma applies in JS -- every message row of the window shipped to
     * be de-duplicated, ~3,000 a tick in a busy room.
     * `(chat_group_id, created_at)` serves both.
     */
    chatGroupId
      ? db.$queryRaw<Array<{ recent: bigint; chatters: bigint }>>`
          SELECT COUNT(*) FILTER (WHERE created_at >= ${tenMinutesAgo}) AS recent,
                 COUNT(DISTINCT user_id) AS chatters
            FROM chat_messages
           WHERE chat_group_id = ${chatGroupId}::uuid
             AND deleted_at IS NULL
             AND created_at >= ${thirtyMinutesAgo}`
      : Promise.resolve([{ recent: BigInt(0), chatters: BigInt(0) }]),
    chatGroupId
      ? db.moderation_flags.count({ where: { chat_group_id: chatGroupId, status: "pending" } })
      : Promise.resolve(0),
    db.event_feedback.findMany({
      where: { event_id: eventId, created_at: { gte: thirtyMinutesAgo } },
      select: { sentiment: true, category: true },
    }),
  ])

  /*
   * Read, not derived. `checkedInTotal - checkedOutTotal` was the only way to
   * ask this of a mutable status column, and it went wrong in both directions:
   * a row the sweeper missed never decremented, and a `checked_out` row from
   * day one made day three's arithmetic negative — hence the `Math.max(0, …)`
   * that was hiding it.
   */
  const inside = live.insideGuests + live.insideStaff
  const staffInside = live.insideStaff
  const checkedInTotal = live.arrived
  const checkedOutTotal = Math.max(0, live.arrived - inside)
  const checkInRate10m = live.arrivedRecently

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

  const figures: LiveFigures = {
    eventId,
    at: now.toISOString(),
    inside: occupancy.inside,
    guestsInside: occupancy.guestsInside,
    staffInside: occupancy.staffInside,
    checkedInTotal,
    checkedOutTotal,
    /*
     * How much of `inside` is inference rather than observation.
     *
     * Nobody is removed from the room for going quiet — a pocketed phone stops
     * reporting within minutes, because the client polls in the foreground
     * only. But a figure that cannot distinguish "seen thirty seconds ago" from
     * "seen an hour ago" is one an organiser has no way to calibrate, and R31
     * is explicit that a soft number should say it is soft where it is shown.
     */
    staleInside: live.stale,
    capacity: occupancy.capacity,
    fillPct: occupancy.fillPct,
    overCapacity: occupancy.overCapacity,
    checkInRate10m,
    medianRate10m: median(buckets),
    messagesPerMinute: Math.round((Number(chat.recent) / 10) * 10) / 10,
    activeChatters30m: Number(chat.chatters),
    openFlags,
    sentiment,
    categories: Array.from(categoryCounts.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
  }

  /*
   * Derived here, on the exact figures, and sent with them. A venue's copy of
   * this snapshot has its counts rounded to ranges (`forVenue`), and an alert
   * derived from a range would fire on the wrong side of every threshold.
   */
  return {
    snapshot: {
      ...figures,
      view: "host",
      alerts: deriveAlerts(figures, { scheduledEnd: event.end_time, scheduledStart: event.start_time, now }),
    },
    event: { start_time: event.start_time, end_time: event.end_time },
    occurrenceId: slot.occurrence?.id ?? null,
  }
}

