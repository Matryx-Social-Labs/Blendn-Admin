import { Prisma, type event_status } from "@prisma/client"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"

/**
 * "Changed while you're going" (Flow 3 · 3.1): when the time, the venue or the
 * status of a published event moved under the people who had heard of it, and
 * what they were before, so the Scene can strike the old time through.
 *
 * Stored as `events.changed_at` and `events.changed_from`, written by the three
 * doors that can move these (the dashboard PATCH, the mobile PATCH and the
 * admin status dropdown) through `recordEventChange`. Which fields changed is
 * derived on read from `changed_from` and the row (`changedFieldsOf`), never
 * stored, so a time moved and put back reads as no change at all.
 */

export type ChangedField = "time" | "venue" | "cancelled"

/** What a change is read against. The columns `materialEventChanges` already compares, plus the status. */
export interface TrackedEvent {
  start_time: Date
  end_time: Date
  venue_name: string | null
  address: string | null
  status: event_status
}

/** The values before the first change still standing. A key is present only for a field that moved. */
// A type, not an interface: Prisma's JSON input needs the index signature only a type alias has.
export type ChangedFrom = {
  start_time?: string
  end_time?: string
  venue_name?: string | null
  address?: string | null
  cancelled?: true
}

/** What the API sends: camelCase, only the fields that moved. */
export interface ChangedFromResponse {
  startTime?: string
  endTime?: string
  venueName?: string | null
  address?: string | null
}

const sameText = (a: string | null | undefined, b: string | null | undefined) => (a ?? "") === (b ?? "")
const sameInstant = (iso: string, d: Date) => new Date(iso).getTime() === d.getTime()

/** `changed_from` as stored, trusting nothing: a value that is not this shape reads as none. */
export function parseChangedFrom(raw: unknown): ChangedFrom {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: ChangedFrom = {}
  for (const key of ["start_time", "end_time"] as const) {
    const v = r[key]
    if (typeof v === "string" && Number.isFinite(new Date(v).getTime())) out[key] = v
  }
  for (const key of ["venue_name", "address"] as const) {
    const v = r[key]
    if (typeof v === "string" || v === null) out[key] = v
  }
  if (r.cancelled === true) out.cancelled = true
  return out
}

export interface ChangeWrite {
  changed_at: Date | null
  changed_from: ChangedFrom | null
}

/**
 * What to write after an edit, or `null` when the edit moved nothing worth
 * telling anyone and the row is to be left as it is.
 *
 * Only a published event records one — a draft has nobody going — and only into
 * published or cancelled: an event put back to a draft is hidden, not changed.
 * The first value of a field wins; a field put back to where it started drops
 * out; when nothing is left the columns clear.
 */
export function nextChange(
  prior: unknown,
  before: TrackedEvent,
  after: TrackedEvent,
  now: Date = new Date()
): ChangeWrite | null {
  if (before.status !== "published") return null
  if (after.status !== "published" && after.status !== "cancelled") return null

  const moved = {
    start_time: before.start_time.getTime() !== after.start_time.getTime(),
    end_time: before.end_time.getTime() !== after.end_time.getTime(),
    venue_name: !sameText(before.venue_name, after.venue_name),
    address: !sameText(before.address, after.address),
    cancelled: after.status === "cancelled",
  }
  if (!Object.values(moved).some(Boolean)) return null

  const from = parseChangedFrom(prior)
  if (moved.start_time && from.start_time === undefined) from.start_time = before.start_time.toISOString()
  if (moved.end_time && from.end_time === undefined) from.end_time = before.end_time.toISOString()
  if (moved.venue_name && !("venue_name" in from)) from.venue_name = before.venue_name
  if (moved.address && !("address" in from)) from.address = before.address
  if (moved.cancelled) from.cancelled = true

  // Put back to where it started: not a change any more.
  if (from.start_time !== undefined && sameInstant(from.start_time, after.start_time)) delete from.start_time
  if (from.end_time !== undefined && sameInstant(from.end_time, after.end_time)) delete from.end_time
  if ("venue_name" in from && sameText(from.venue_name, after.venue_name)) delete from.venue_name
  if ("address" in from && sameText(from.address, after.address)) delete from.address

  return Object.keys(from).length === 0
    ? { changed_at: null, changed_from: null }
    : { changed_at: now, changed_from: from }
}

/** The fields still standing, in the order the app lists them. Empty when none. */
export function changedFieldsOf(raw: unknown, current: TrackedEvent): ChangedField[] {
  const from = parseChangedFrom(raw)
  const fields: ChangedField[] = []
  const timeMoved =
    (from.start_time !== undefined && !sameInstant(from.start_time, current.start_time)) ||
    (from.end_time !== undefined && !sameInstant(from.end_time, current.end_time))
  if (timeMoved) fields.push("time")
  const venueMoved =
    ("venue_name" in from && !sameText(from.venue_name, current.venue_name)) ||
    ("address" in from && !sameText(from.address, current.address))
  if (venueMoved) fields.push("venue")
  if (from.cancelled && current.status === "cancelled") fields.push("cancelled")
  return fields
}

/**
 * The three response fields for an event row: when, which, and what it was.
 * All null or empty for an event that has not changed, which is almost all.
 */
export function changeForResponse(
  row: TrackedEvent & { changed_at: Date | null; changed_from: unknown }
): { changedAt: Date | null; changedFields: ChangedField[]; changedFrom: ChangedFromResponse | null } {
  const changedFields = row.changed_at ? changedFieldsOf(row.changed_from, row) : []
  if (changedFields.length === 0) return { changedAt: null, changedFields: [], changedFrom: null }

  const from = parseChangedFrom(row.changed_from)
  const changedFrom: ChangedFromResponse = {
    ...(from.start_time !== undefined && !sameInstant(from.start_time, row.start_time) && { startTime: from.start_time }),
    ...(from.end_time !== undefined && !sameInstant(from.end_time, row.end_time) && { endTime: from.end_time }),
    ...("venue_name" in from && !sameText(from.venue_name, row.venue_name) && { venueName: from.venue_name }),
    ...("address" in from && !sameText(from.address, row.address) && { address: from.address }),
  }
  return {
    changedAt: row.changed_at,
    changedFields,
    changedFrom: Object.keys(changedFrom).length > 0 ? changedFrom : null,
  }
}

/**
 * Record an edit's change. Called straight after the write that made it; never
 * throws, because the edit has committed and a failed bookkeeping write must not
 * turn it into a 500.
 *
 * ponytail: read-modify-write on the row the caller loaded before its update, so
 * two edits landing within the same few milliseconds can each start from the same
 * `changed_from`, and the later one wins. A transaction with the update closes it
 * if it is ever seen.
 */
export async function recordEventChange(
  eventId: string,
  before: TrackedEvent & { changed_from: unknown },
  after: TrackedEvent
): Promise<void> {
  try {
    const next = nextChange(before.changed_from, before, after)
    if (!next) return
    await db.events.update({
      where: { id: eventId },
      data: {
        changed_at: next.changed_at,
        changed_from: next.changed_from ?? Prisma.DbNull,
      },
    })
  } catch (error) {
    logger.error("Failed to record an event change", { eventId, error: error instanceof Error ? error.message : String(error) })
  }
}
