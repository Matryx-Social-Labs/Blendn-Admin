// Relative, not "@/lib/db" — reachable from server.ts via lib/occupancy.ts, and
// `build:server` emits the alias verbatim into the require(). Enforced by
// __tests__/server-import-boundary.test.ts.
import { db } from "./db"

/**
 * Which day of an event a check-in belongs to.
 *
 * Every event has at least one occurrence, so this always has an answer — that
 * totality is what lets `event_check_ins.occurrence_id` be NOT NULL, and what
 * keeps the per-day uniqueness constraint meaningful. A nullable occurrence
 * would allow unlimited NULLs in the unique index, which would quietly remove
 * the one-check-in-per-person guarantee from every single-day event.
 */

export interface OccurrenceSlot {
  id: string
  occursOn: Date
  startTime: Date
  endTime: Date
  capacity: number | null
  cancelledAt: Date | null
}

/** How far before a session's start check-in opens. Doors, not the programme. */
export const CHECK_IN_LEAD_MINUTES = 90

/**
 * Whether people can still be arriving: from the doors, `CHECK_IN_LEAD_MINUTES`
 * before the start, to the end. A count of who came moves by one with every
 * arrival over that window, so a venue is not given it as a number until the
 * window has closed (SCRUM-516). Pass a day's own times for one day of a run.
 */
export function stillArriving(window: { start_time: Date; end_time: Date }, now: Date = new Date()): boolean {
  return now.getTime() >= window.start_time.getTime() - CHECK_IN_LEAD_MINUTES * 60_000 && now < window.end_time
}

/** What `pickOccurrence` decides about the door right now. */
export type OccurrenceVerdict =
  | { ok: true; occurrence: OccurrenceSlot }
  | { ok: false; reason: "too_early" | "too_late" | "cancelled" | "none"; occurrence: OccurrenceSlot | null }

/**
 * The occurrence someone checking in right now is checking in to.
 *
 * Picks the session whose window contains `now`, allowing a lead-in for doors.
 * If none is open, returns the nearest one and says why it is not open, so the
 * caller can tell "you are a day early" from "that day is cancelled" — the
 * client shows very different things for those.
 *
 * A single-day event has exactly one occurrence, so this collapses to the old
 * behaviour without a special case.
 */
export async function resolveOccurrence(
  eventId: string,
  now: Date = new Date()
): Promise<OccurrenceVerdict & { slots: OccurrenceSlot[] }> {
  const rows = await db.event_occurrences.findMany({
    where: { event_id: eventId },
    orderBy: { start_time: "asc" },
    select: {
      id: true,
      occurs_on: true,
      start_time: true,
      end_time: true,
      capacity: true,
      cancelled_at: true,
    },
  })

  const slots: OccurrenceSlot[] = rows.map((r) => ({
    id: r.id,
    occursOn: r.occurs_on,
    startTime: r.start_time,
    endTime: r.end_time,
    capacity: r.capacity,
    cancelledAt: r.cancelled_at,
  }))

  return { ...pickOccurrence(slots, now), slots }
}

/**
 * `resolveOccurrence` without the database. `slots` are in start order.
 *
 * "Too early" names the next day that is actually going ahead. It used to name
 * the next day, full stop — so on a festival whose last day was called off,
 * the evening after day 2 answered "Event has not started yet" about the
 * cancelled day 3, two days after the festival had started (staging,
 * `blr-design-festival`, 2026-09-28). When every day still to come is
 * cancelled, that is the answer: `cancelled`, with the first of them.
 */
export function pickOccurrence(slots: readonly OccurrenceSlot[], now: Date): OccurrenceVerdict {
  if (slots.length === 0) return { ok: false, reason: "none", occurrence: null }

  const lead = CHECK_IN_LEAD_MINUTES * 60_000
  const open = slots.find(
    (s) => now.getTime() >= s.startTime.getTime() - lead && now <= s.endTime
  )

  if (open) {
    // A cancelled day is not a window you can walk into, even though its times
    // still say so.
    if (open.cancelledAt) return { ok: false, reason: "cancelled", occurrence: open }
    return { ok: true, occurrence: open }
  }

  const upcoming = slots.filter((s) => now.getTime() < s.startTime.getTime() - lead)
  const next = upcoming.find((s) => !s.cancelledAt)
  if (next) return { ok: false, reason: "too_early", occurrence: next }
  if (upcoming.length > 0) return { ok: false, reason: "cancelled", occurrence: upcoming[0] }

  return { ok: false, reason: "too_late", occurrence: slots[slots.length - 1] }
}

/** When the app should say an event happens, as the API sends it. */
export interface EventSession {
  startTime: Date
  endTime: Date
}

/**
 * The session the app should talk about right now: the one running, else the
 * next one going ahead, else the last one that went ahead (so it reads as
 * ended). Null when every day has been called off.
 *
 * This is the app's "is it live?" window. An event's own `start_time` and
 * `end_time` are the whole run, so on a three-day festival they said LIVE for
 * three days straight — through the nights between days and through a
 * cancelled last day — while the door, which goes by occurrence, refused.
 * Sending the session lets the app ask the same question the door does
 * instead of re-deriving days on the phone.
 *
 * No check-in lead here: this says when it is on, not when doors open.
 * Rows without occurrences (a caller that did not select them, or a legacy
 * event) fall back to the event's own window — for a single-day event that is
 * the same thing.
 */
export function eventSession(
  event: {
    start_time: Date
    end_time: Date
    occurrences?: readonly { start_time: Date; end_time: Date; cancelled_at: Date | null }[]
  },
  now: Date = new Date()
): EventSession | null {
  const slots = event.occurrences
  if (!slots || slots.length === 0) return { startTime: event.start_time, endTime: event.end_time }

  const held = slots
    .filter((s) => !s.cancelled_at)
    .sort((a, b) => a.start_time.getTime() - b.start_time.getTime())
  if (held.length === 0) return null

  // In start order, the first that has not ended is the running one or the next.
  const current = held.find((s) => now < s.end_time) ?? held[held.length - 1]
  return { startTime: current.start_time, endTime: current.end_time }
}

/** The occurrence columns `eventSession` reads, for a Prisma `select`. */
export const sessionOccurrencesSelect = {
  select: { start_time: true, end_time: true, cancelled_at: true },
  orderBy: { start_time: "asc" as const },
}

/**
 * Create the occurrences for an event's span.
 *
 * One per local calendar day between start and end. A club night that runs past
 * midnight is **one** occurrence, not two: it is a single session that happens
 * to cross a date boundary, and splitting it would let someone check in twice
 * to the same night.
 */
export function occurrencesForSpan(
  start: Date,
  end: Date,
  timezone: string
): { occursOn: Date; startTime: Date; endTime: Date }[] {
  const dayKey = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d)

  const first = dayKey(start)
  const last = dayKey(end)

  // Same local day, or a session crossing midnight into the next — both are one
  // occurrence. The test for "spans multiple days" is a full day boundary, not
  // a date change.
  const spanHours = (end.getTime() - start.getTime()) / 3_600_000
  if (first === last || spanHours <= 24) {
    return [{ occursOn: new Date(`${first}T00:00:00Z`), startTime: start, endTime: end }]
  }

  const out: { occursOn: Date; startTime: Date; endTime: Date }[] = []
  const cursor = new Date(start)
  while (dayKey(cursor) <= last) {
    const key = dayKey(cursor)
    const isFirst = key === first
    const isLast = key === last

    // The first and last days keep the event's real times; the days between
    // inherit the first day's clock, which is what a conference programme
    // actually looks like.
    const startTime = isFirst ? start : atClockOf(cursor, start, timezone)
    let endTime = isLast ? end : atClockOf(cursor, end, timezone)

    /*
     * A night that runs past local midnight ends on the NEXT date.
     *
     * `atClockOf` puts the end's clock time onto this day's date, which is
     * right for a programme running 09:00–18:00 and wrong for one running
     * 21:00–03:00: three in the morning is earlier in the day than nine at
     * night, so the occurrence came out ending six hours before it began.
     *
     * Real example from the seeded world — Design Week, Asia/Kolkata, an event
     * spanning 09-04 21:09 to 09-06 03:09 local:
     *
     *     occurs_on 09-04   start 09-04 15:39Z   end 09-03 21:39Z
     *
     * Nothing caught it because no constraint forbids it and every reader
     * treats the pair as an interval without checking it is one. The
     * `presence_sessions` CHECK is what surfaced it: backfilling refused rows
     * that departed before they arrived.
     */
    if (endTime <= startTime) {
      if (isLast) {
        /*
         * The tail of a night already covered by the previous day's occurrence.
         * Emitting it would create a day whose whole extent is before it
         * starts — and, on a two-night event, a third occurrence for a night
         * nobody is holding.
         */
        break
      }
      endTime = new Date(endTime.getTime() + 24 * 3_600_000)
    }

    out.push({ occursOn: new Date(`${key}T00:00:00Z`), startTime, endTime })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/** Put `template`'s time-of-day onto `day`'s date, in the event's timezone. */
function atClockOf(day: Date, template: Date, timezone: string): Date {
  const dayStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(day)
  const timeStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(template)
  // Reinterpreting through the same formatter keeps DST honest: the offset is
  // whatever that zone had on that date, not whatever it has today.
  return new Date(`${dayStr}T${timeStr}:00${offsetFor(dayStr, timezone)}`)
}

function offsetFor(dayStr: string, timezone: string): string {
  const probe = new Date(`${dayStr}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(probe)
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00"
  return name.replace("GMT", "") || "+00:00"
}

/**
 * Create or reconcile an event's occurrences from its span.
 *
 * Called whenever an event's schedule is written. Idempotent: days that already
 * exist keep their id — and therefore their check-ins — while days that fall
 * outside the new span are removed.
 *
 * Removing a day cascades its check-ins, which is why shrinking a run is a real
 * decision and not a silent tidy-up. It is the correct behaviour: a day that no
 * longer happens has no attendance.
 */
export async function syncOccurrences(
  eventId: string,
  start: Date,
  end: Date,
  timezone: string
): Promise<void> {
  const wanted = occurrencesForSpan(start, end, timezone)
  const wantedKeys = new Set(wanted.map((w) => w.occursOn.toISOString().slice(0, 10)))

  const existing = await db.event_occurrences.findMany({
    where: { event_id: eventId },
    select: { id: true, occurs_on: true },
  })
  const existingKeys = new Map(
    existing.map((e) => [e.occurs_on.toISOString().slice(0, 10), e.id])
  )

  for (const day of wanted) {
    const key = day.occursOn.toISOString().slice(0, 10)
    const id = existingKeys.get(key)
    if (id) {
      // Times can shift without the day changing — a programme that now starts
      // an hour earlier. Keeping the row keeps its check-ins.
      await db.event_occurrences.update({
        where: { id },
        data: { start_time: day.startTime, end_time: day.endTime },
      })
    } else {
      await db.event_occurrences.create({
        data: {
          event_id: eventId,
          occurs_on: day.occursOn,
          start_time: day.startTime,
          end_time: day.endTime,
        },
      })
    }
  }

  const orphaned = existing.filter(
    (e) => !wantedKeys.has(e.occurs_on.toISOString().slice(0, 10))
  )
  if (orphaned.length === 0) return

  /*
   * A day that falls outside the new span is cancelled, not deleted — unless
   * nobody attended it.
   *
   * `event_check_ins.occurrence_id` cascades, so deleting an occurrence
   * destroys its attendance. An organiser correcting an end date by a day
   * would silently erase who came on the last day, with no warning and no
   * undo. Attendance is a record of something that actually happened; the
   * schedule changing does not unhappen it.
   *
   * Days nobody attended are deleted, because an empty row for a day that
   * never ran is just noise.
   */
  const withAttendance = await db.event_check_ins.groupBy({
    by: ["occurrence_id"],
    where: { occurrence_id: { in: orphaned.map((o) => o.id) } },
    _count: { _all: true },
  })
  const attended = new Set(withAttendance.map((r) => r.occurrence_id))

  const toCancel = orphaned.filter((o) => attended.has(o.id)).map((o) => o.id)
  const toDelete = orphaned.filter((o) => !attended.has(o.id)).map((o) => o.id)

  if (toCancel.length > 0) {
    await db.event_occurrences.updateMany({
      where: { id: { in: toCancel }, cancelled_at: null },
      data: { cancelled_at: new Date() },
    })
  }
  if (toDelete.length > 0) {
    await db.event_occurrences.deleteMany({ where: { id: { in: toDelete } } })
  }
}
