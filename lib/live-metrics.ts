import { db } from "@/lib/db"

/**
 * The live aggregate snapshot pushed to `event:{id}:ops`.
 *
 * **Aggregates only, by construction.** No attendee row, user id, name or
 * message text crosses this channel. Event chat is pseudonymous and that has to
 * hold on the wire as well as in the REST payload — a live feed that streamed
 * `userId` would reintroduce the identity leak through a side door, and this
 * time in something long-lived that nobody inspects.
 */
export interface LiveSnapshot {
  eventId: string
  at: string
  /** Currently inside: checked in and not checked out. */
  inside: number
  checkedInTotal: number
  checkedOutTotal: number
  capacity: number | null
  /** Percent of capacity currently inside, or null when no capacity is set. */
  fillPct: number | null
  /** Check-ins in the last 10 minutes — the arrival-rate signal. */
  checkInRate10m: number
  /** Median 10-minute rate so far tonight, for "×3 median" style context. */
  medianRate10m: number
  messagesPerMinute: number
  activeChatters30m: number
  openFlags: number
  sentiment: { positive: number; neutral: number; negative: number }
  /** Negative + safety messages by category, last 30 minutes. */
  categories: Array<{ category: string; count: number }>
}

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
      max_capacity: true,
      chat_group: { select: { id: true } },
    },
  })
  if (!event) return null

  const tenMinutesAgo = new Date(now.getTime() - 10 * MINUTE)
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * MINUTE)
  const chatGroupId = event.chat_group?.id

  const [checkIns, recentMessages, activeChatters, openFlags, feedback] = await Promise.all([
    db.event_check_ins.findMany({
      where: { event_id: eventId },
      select: { check_in_time: true, check_out_time: true, status: true },
    }),
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

  const checkedInTotal = checkIns.filter(
    (c) => c.status === "checked_in" || c.status === "checked_out"
  ).length
  const checkedOutTotal = checkIns.filter((c) => c.check_out_time !== null).length
  const inside = Math.max(0, checkedInTotal - checkedOutTotal)

  const checkInRate10m = checkIns.filter(
    (c) => c.check_in_time && c.check_in_time >= tenMinutesAgo
  ).length

  /*
   * Median of every completed 10-minute bucket since doors. The rate alone says
   * nothing — 31 arrivals is a stampede for a book club and a slow night for a
   * festival — so the alert compares against this event's own baseline.
   */
  const buckets: number[] = []
  const doors = event.start_time
  for (let t = doors.getTime(); t + 10 * MINUTE <= now.getTime(); t += 10 * MINUTE) {
    const from = new Date(t)
    const to = new Date(t + 10 * MINUTE)
    buckets.push(
      checkIns.filter((c) => c.check_in_time && c.check_in_time >= from && c.check_in_time < to)
        .length
    )
  }

  const sentiment = { positive: 0, neutral: 0, negative: 0 }
  const categoryCounts = new Map<string, number>()
  for (const row of feedback) {
    sentiment[row.sentiment] += 1
    // Only what needs attention: positives by category are noise on a live
    // screen whose job is surfacing problems.
    if (row.sentiment === "negative" || row.category === "safety_conduct") {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
    }
  }

  return {
    eventId,
    at: now.toISOString(),
    inside,
    checkedInTotal,
    checkedOutTotal,
    capacity: event.max_capacity,
    fillPct:
      event.max_capacity && event.max_capacity > 0
        ? Math.min(100, (inside / event.max_capacity) * 100)
        : null,
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

export type LiveAlertKind =
  | "entry_backing_up"
  | "approaching_capacity"
  | "leaving_early"
  | "safety"
  | "mood_sliding"
  | "room_died"

export interface LiveAlert {
  kind: LiveAlertKind
  severity: "critical" | "warning"
  title: string
  body: string
}

/**
 * Derive alerts from a snapshot.
 *
 * The ones worth firing combine chat and check-in signal, because neither means
 * much alone: a check-in spike is just a popular act arriving, and complaints
 * about a queue are routine — together they are a door that has stopped moving.
 *
 * Pure so it can be tested without a database or a clock.
 */
export function deriveAlerts(
  snapshot: LiveSnapshot,
  opts: { scheduledEnd: Date; now?: Date }
): LiveAlert[] {
  const alerts: LiveAlert[] = []
  const now = opts.now ?? new Date(snapshot.at)

  const entryComplaints =
    snapshot.categories.find((c) => c.category === "entry_queue")?.count ?? 0
  const safety = snapshot.categories.find((c) => c.category === "safety_conduct")?.count ?? 0

  // Category, not tone: a calmly-worded report is still a report.
  if (safety > 0) {
    alerts.push({
      kind: "safety",
      severity: "critical",
      title: "Safety",
      body: `${safety} safety_conduct message${safety === 1 ? "" : "s"} in chat. Routed to moderation regardless of sentiment.`,
    })
  }

  if (
    snapshot.medianRate10m > 0 &&
    snapshot.checkInRate10m >= snapshot.medianRate10m * 2 &&
    entryComplaints >= 3
  ) {
    alerts.push({
      kind: "entry_backing_up",
      severity: "warning",
      title: "Entry backing up",
      body: `Check-in rate ${snapshot.checkInRate10m}/10min (×${(snapshot.checkInRate10m / snapshot.medianRate10m).toFixed(1)} median) and ${entryComplaints} entry-queue messages. Neither signal alone fires this.`,
    })
  }

  if (snapshot.fillPct !== null && snapshot.fillPct >= 90) {
    alerts.push({
      kind: "approaching_capacity",
      severity: "warning",
      title: "Approaching capacity",
      body: `${snapshot.inside} inside of ${snapshot.capacity} — ${Math.round(snapshot.fillPct)}%.`,
    })
  }

  // Only meaningful before the event is due to end; afterwards leaving is what
  // people are supposed to be doing.
  const minutesToEnd = (opts.scheduledEnd.getTime() - now.getTime()) / MINUTE
  if (minutesToEnd > 30 && snapshot.checkedInTotal > 0) {
    const leftShare = snapshot.checkedOutTotal / snapshot.checkedInTotal
    if (leftShare >= 0.25) {
      alerts.push({
        kind: "leaving_early",
        severity: "warning",
        title: "Leaving early",
        body: `${snapshot.checkedOutTotal} of ${snapshot.checkedInTotal} have checked out with ${Math.round(minutesToEnd)} minutes still to run.`,
      })
    }
  }

  const classified =
    snapshot.sentiment.positive + snapshot.sentiment.neutral + snapshot.sentiment.negative
  // A threshold on a handful of messages is noise, not a mood.
  if (classified >= 10 && snapshot.sentiment.negative / classified >= 0.4) {
    alerts.push({
      kind: "mood_sliding",
      severity: "warning",
      title: "Mood sliding",
      body: `${snapshot.sentiment.negative} of ${classified} classified messages in the last 30 minutes are negative.`,
    })
  }

  return alerts
}
