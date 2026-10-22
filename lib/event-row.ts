import { whenLabel } from "./dashboard-format"
import { eventClock } from "./event-phase"

export type EventRowStatus = "draft" | "published" | "cancelled" | "completed"

/** Where an event sits in time, decided on the server where `now` is one value. */
export type EventRowPhase = "upcoming" | "live" | "past"

/** The Events list's three tabs. A draft is a draft whatever its date. */
export type EventRowTab = "upcoming" | "drafts" | "past"

/**
 * One event as the kit's `EventRow` draws it: on the Events list and in the
 * overview's Coming up. Plain data, so it crosses into a client component.
 */
export interface EventRowData {
  id: string
  title: string
  status: EventRowStatus
  /** The date tile, on the event's own clock (SCRUM-496). */
  day: string
  month: string
  /** "12 Oct, 18:00", or a range for a multi-day run. Server-rendered: see `whenLabel`. */
  when: string
  where: string | null
  phase: EventRowPhase
  tab: EventRowTab
  /**
   * Published with no pin and no fence. `canPublish` refuses that now, and
   * events published before it did 400 at the door with nothing saying why.
   */
  unfenced: boolean
  capacity: number | null
  /** Going RSVPs. Null when held back: a venue's view of another host's night (SCRUM-501). */
  going: number | null
  /** Distinct people who checked in. Null when held back. */
  arrivals: number | null
}

/**
 * The fields of a row that come from the event alone — everything but the
 * counts, which each caller scopes to who is looking.
 */
export function eventRowFields(
  event: {
    id: string
    title: string
    status: EventRowStatus
    start_time: Date
    end_time: Date
    timezone: string
    venue_name: string | null
    city: string | null
    latitude: number | null
    geofence: unknown
    max_capacity: number | null
  },
  now: Date
): Omit<EventRowData, "going" | "arrivals"> {
  const clock = eventClock(event.timezone)
  const phase: EventRowPhase =
    event.status === "cancelled" || event.status === "completed" || event.end_time < now
      ? "past"
      : event.status === "published" && event.start_time <= now
        ? "live"
        : "upcoming"
  return {
    id: event.id,
    title: event.title,
    status: event.status,
    day: clock.format(event.start_time, { day: "numeric" }),
    month: clock.format(event.start_time, { month: "short" }),
    when: whenLabel(event.start_time, event.end_time, now, event.timezone),
    where: event.venue_name ?? event.city ?? null,
    // A draft is never live or past to the organiser: it is waiting on them.
    phase: event.status === "draft" ? "upcoming" : phase,
    tab: event.status === "draft" ? "drafts" : phase === "past" ? "past" : "upcoming",
    unfenced: event.status === "published" && event.latitude === null && event.geofence === null,
    capacity: event.max_capacity && event.max_capacity > 0 ? event.max_capacity : null,
  }
}

/**
 * The attendance cell: one number, what it counts, and how full the bar is.
 *
 * The number changes meaning with the phase, because the question does: before
 * the doors it is who is going against capacity, while the night runs who has
 * checked in, and afterwards who came against who said they would (turn-up).
 *
 * A held-back count and a count of nobody both read "—", deliberately: the
 * mark must not tell a night of none from a night of four (SCRUM-501). The bar
 * is drawn only from numbers that are shown.
 */
export function attendanceLine(row: Pick<EventRowData, "phase" | "capacity" | "going" | "arrivals">): {
  value: number | null
  label: string
  /** 0–100 for the bar, or null for no bar. */
  pct: number | null
} {
  const bar = (part: number | null, whole: number | null) =>
    part && whole ? Math.min(100, Math.round((part / whole) * 100)) : null

  if (row.phase === "live") {
    const value = row.arrivals || null
    return { value, label: "checked in", pct: bar(value, row.capacity) }
  }
  if (row.phase === "past") {
    const value = row.arrivals || null
    return {
      value,
      label: row.going ? `came · of ${row.going} going` : "came",
      pct: bar(value, row.going),
    }
  }
  return {
    value: row.going,
    label: row.capacity ? `of ${row.capacity} going` : "going",
    pct: bar(row.going, row.capacity),
  }
}
