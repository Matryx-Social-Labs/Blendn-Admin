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
): Promise<
  | { ok: true; occurrence: OccurrenceSlot }
  | { ok: false; reason: "too_early" | "too_late" | "cancelled" | "none"; occurrence: OccurrenceSlot | null }
> {
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

  const upcoming = slots.find((s) => now.getTime() < s.startTime.getTime() - lead)
  if (upcoming) return { ok: false, reason: "too_early", occurrence: upcoming }

  return { ok: false, reason: "too_late", occurrence: slots[slots.length - 1] }
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
    out.push({
      occursOn: new Date(`${key}T00:00:00Z`),
      // The first and last days keep the event's real times; the days between
      // inherit the first day's clock, which is what a conference programme
      // actually looks like.
      startTime: isFirst ? start : atClockOf(cursor, start, timezone),
      endTime: isLast ? end : atClockOf(cursor, end, timezone),
    })
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
