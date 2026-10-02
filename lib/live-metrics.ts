/**
 * Live event metrics — types and alert rules.
 *
 * Deliberately free of any database import. `LiveTab` is a client component
 * and imports from here; when this module also imported `db`,
 * Turbopack followed it into `pg` and the browser build failed on `dns`. The
 * query that produces a snapshot lives in `lib/live-snapshot.ts`, which is
 * server-only.
 */

import { liveCountBucket, type LiveCountBucket } from "./disclosure"

/** The exact figures, and what the alert rules read. Never sent to a venue. */
export interface LiveFigures {
  eventId: string
  at: string
  /** Currently inside — staff included, because fire safety counts bodies. */
  inside: number
  /** Of those inside, the ones who are not working the event. */
  guestsInside: number
  staffInside: number
  checkedInTotal: number
  checkedOutTotal: number
  /**
   * Of those inside, how many have not reported a position recently.
   *
   * Not subtracted from `inside`: silence is not evidence of leaving, because
   * the client polls in the foreground only and a pocketed phone goes quiet
   * within minutes. This is what lets the screen say which part of the figure
   * is inferred rather than observed.
   */
  staleInside: number
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

/** What whoever runs the event (or an admin) is sent: the figures, and their alerts. */
export interface LiveSnapshot extends LiveFigures {
  view: "host"
  alerts: LiveAlert[]
}

/**
 * What a venue is sent while it watches another host's night or its own venue
 * day (SCRUM-516): every count of people as a range, and the flags that matter
 * for the building decided on the exact figures before they were rounded.
 *
 * Messages per minute and open flags stay exact. The venue moderates this room:
 * it reads every message and the flag queue, so neither tells it anything the
 * chat does not.
 */
export interface VenueLiveSnapshot {
  view: "venue"
  eventId: string
  at: string
  inside: LiveCountBucket
  guestsInside: LiveCountBucket
  staffInside: LiveCountBucket
  checkedInTotal: LiveCountBucket
  checkedOutTotal: LiveCountBucket
  staleInside: LiveCountBucket
  /** `occupancyMostlyInferred`, on the exact figures. */
  mostlyInferred: boolean
  capacity: number | null
  overCapacity: boolean
  checkInRate10m: LiveCountBucket
  messagesPerMinute: number
  activeChatters30m: LiveCountBucket
  openFlags: number
  sentiment: { positive: LiveCountBucket; neutral: LiveCountBucket; negative: LiveCountBucket }
  categories: Array<{ category: string; count: LiveCountBucket }>
  alerts: LiveAlert[]
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
/**
 * Above this share of the room unseen recently, the headcount is mostly
 * inference and should say so.
 *
 * Half, matching `departureQuality`'s line for the same judgement: below it the
 * gaps are a few people whose phones are asleep, above it the figure is being
 * carried by sessions nobody has confirmed.
 */
export const MOSTLY_INFERRED_SHARE = 0.5

/**
 * Is the headcount mostly inferred rather than observed?
 *
 * Nobody is removed from the room for going quiet — the client polls in the
 * foreground only, so a pocketed phone stops reporting within minutes and
 * timing that out would empty a full room. The cost of that choice is that the
 * figure can drift upward if the sweeper stalls, and the price of keeping
 * people in the room is saying plainly when the number is inference.
 *
 * `OccupancyHero` already renders this: a "count unreliable" badge, a `~`
 * prefix, "in the room, roughly", and the over-capacity flag suppressed —
 * because flagging a breach off numbers we have just said we do not trust is
 * how a false evacuation starts. It had no caller until now. The prop was
 * added for the mass-checkout guard, which #278 deleted; the affordance
 * outlived its cause and this is the cause it was actually needed for.
 */
export function occupancyMostlyInferred(snapshot: {
  inside: number
  staleInside: number
}): boolean {
  if (snapshot.inside <= 0) return false
  return snapshot.staleInside / snapshot.inside > MOSTLY_INFERRED_SHARE
}

export function deriveAlerts(
  snapshot: LiveFigures,
  opts: { scheduledEnd: Date; scheduledStart?: Date; now?: Date }
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

  /*
   * A full room that has stopped talking.
   *
   * This kind was declared and never emitted — the one alert about the actual
   * product failing rather than the venue. People came, they are still here, and
   * the networking the whole thing exists for is not happening.
   *
   * Three guards against crying wolf, because a quiet room is usually just a
   * quiet moment:
   *
   *   - **Thirty minutes in.** Arrivals do not chat immediately; firing at doors
   *     would be an alert on every event ever held. Without a start time the
   *     rule cannot know that, so it does not fire at all.
   *   - **Ten people.** Three people not talking is three people, not a signal.
   *   - **Nobody at all in half an hour.** Not "quieter than usual" — silent.
   *     `activeChatters30m` is distinct senders, so one person talking to
   *     themselves is still enough to say the room is alive.
   *
   * And not once the event is nearly over, where a room winding down is what is
   * supposed to happen.
   */
  const minutesSinceStart = opts.scheduledStart
    ? (now.getTime() - opts.scheduledStart.getTime()) / MINUTE
    : null
  if (
    minutesSinceStart !== null &&
    minutesSinceStart >= 30 &&
    minutesToEnd > 30 &&
    snapshot.inside >= 10 &&
    snapshot.activeChatters30m === 0 &&
    snapshot.messagesPerMinute === 0
  ) {
    alerts.push({
      kind: "room_died",
      severity: "warning",
      title: "Room has gone quiet",
      body: `${snapshot.inside} people inside and nobody has posted in 30 minutes. The chatroom is the introduction — a silent room means it isn't happening.`,
    })
  }

  return alerts
}

/**
 * Each alert as a venue reads it: the condition, and no figure. The bodies above
 * carry the counts ("3 of 12 have checked out"); a venue gets the same alert,
 * decided on the same numbers, without them. Also applied to the logged
 * issues, whose bodies are these alerts' bodies written down.
 *
 * Two are not sent at all (null). Each fires at an exact count against a line
 * the venue can work out -- nine-tenths of a stated capacity, a quarter of the
 * arrivals -- so the moment it flips says how many, to the person. Over
 * capacity flips the same way and is sent anyway: the building's safety is
 * the venue's to keep. The rest turn on messages the venue moderates, on a
 * baseline it is never shown, or at ten inside, where the range already
 * changes.
 */
const FOR_THE_VENUE: Record<LiveAlertKind, string | null> = {
  safety: "Safety messages in chat. Routed to moderation regardless of sentiment.",
  entry_backing_up: "Arrivals well above tonight's usual pace, with entry-queue complaints in chat.",
  over_capacity: "More guests than the event's stated capacity.",
  approaching_capacity: null,
  leaving_early: null,
  mood_sliding: "Most of the recent classified messages are negative.",
  room_died: "A busy room where nobody has posted in 30 minutes.",
}

/** Alerts, or logged issues, as a venue is sent them. An unknown kind is not sent. */
export function alertsForVenue<T extends { kind: string; body: string }>(alerts: readonly T[]): T[] {
  return alerts.flatMap((alert) => {
    const body = FOR_THE_VENUE[alert.kind as LiveAlertKind]
    return body ? [{ ...alert, body }] : []
  })
}

/**
 * The host's snapshot as a venue may see it.
 *
 * Field by field rather than a spread, so a figure added to `LiveFigures` later
 * reaches a venue only when somebody writes it in here.
 */
export function forVenue(s: LiveSnapshot): VenueLiveSnapshot {
  return {
    view: "venue",
    eventId: s.eventId,
    at: s.at,
    inside: liveCountBucket(s.inside),
    guestsInside: liveCountBucket(s.guestsInside),
    staffInside: liveCountBucket(s.staffInside),
    checkedInTotal: liveCountBucket(s.checkedInTotal),
    checkedOutTotal: liveCountBucket(s.checkedOutTotal),
    staleInside: liveCountBucket(s.staleInside),
    mostlyInferred: occupancyMostlyInferred(s),
    capacity: s.capacity,
    overCapacity: s.overCapacity,
    checkInRate10m: liveCountBucket(s.checkInRate10m),
    messagesPerMinute: s.messagesPerMinute,
    activeChatters30m: liveCountBucket(s.activeChatters30m),
    openFlags: s.openFlags,
    sentiment: {
      positive: liveCountBucket(s.sentiment.positive),
      neutral: liveCountBucket(s.sentiment.neutral),
      negative: liveCountBucket(s.sentiment.negative),
    },
    categories: s.categories.map((c) => ({ category: c.category, count: liveCountBucket(c.count) })),
    alerts: alertsForVenue(s.alerts),
  }
}
