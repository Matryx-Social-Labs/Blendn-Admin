/**
 * Live event metrics — types and alert rules.
 *
 * Deliberately free of any database import. `LiveTab` is a client component
 * and imports `deriveAlerts` from here; when this module also imported `db`,
 * Turbopack followed it into `pg` and the browser build failed on `dns`. The
 * query that produces a snapshot lives in `lib/live-snapshot.ts`, which is
 * server-only.
 */

export interface LiveSnapshot {
  eventId: string
  at: string
  /** Currently inside — staff included, because fire safety counts bodies. */
  inside: number
  /** Of those inside, the ones who are not working the event. */
  guestsInside: number
  staffInside: number
  checkedInTotal: number
  checkedOutTotal: number
  capacity: number | null
  /**
   * Guests as a percent of capacity, or null when no capacity is set.
   *
   * Measured against guests rather than everyone inside — four crew must not
   * fill a room of four — and **uncapped**, so a full room reads 110% rather
   * than pinning at 100 and hiding the breach.
   */
  fillPct: number | null
  /** Over its stated capacity. A signal to show, never an error to raise. */
  overCapacity: boolean
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

export type LiveAlertKind =
  | "entry_backing_up"
  | "approaching_capacity"
  | "over_capacity"
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

  /*
   * Past capacity is a different alert from nearly-at-it, and it exists at all
   * only because check-in stopped refusing at the line — the geofence covers the
   * queue outside, so the hundred-and-first arrival is at the door rather than
   * turned away. The room being over its stated size is now observable, and it
   * is the crowd-safety moment this screen is for. Nothing is broken, so it is a
   * signal rather than an error, but it outranks "approaching".
   */
  if (snapshot.overCapacity && snapshot.capacity !== null) {
    alerts.push({
      kind: "over_capacity",
      severity: "critical",
      title: "Over stated capacity",
      body: `${snapshot.guestsInside} guests against capacity ${snapshot.capacity} — ${snapshot.guestsInside - snapshot.capacity} over. Staff aren't counted toward fill; ${snapshot.inside} bodies are in the room.`,
    })
  } else if (snapshot.fillPct !== null && snapshot.fillPct >= 90) {
    alerts.push({
      kind: "approaching_capacity",
      severity: "warning",
      title: "Approaching capacity",
      body: `${snapshot.guestsInside} guests of ${snapshot.capacity} — ${Math.round(snapshot.fillPct)}%.`,
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
