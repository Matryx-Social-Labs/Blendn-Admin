import { ATTENDED, noShows } from "./counting"
import type { user_role } from "@prisma/client"

import { db } from "./db"
import { MIN_CELL } from "./disclosure"
import { attendeeLabel } from "./pseudonym"
import { eventPermissionSelect, eventPermissions, type PermissionActor } from "./rbac"
import { eventScopeFor, pseudonymScope } from "./reports"

/**
 * One attendee as a host sees them: a label and counts, never who they are.
 *
 * Owner ruling SCRUM-383 (b), 2026-09-28: organisers, venue owners and sponsors
 * see attendees only as a pseudonymous label plus counts -- never a name,
 * email, phone, photo or profile. Platform admins keep full account details,
 * and they have them on `/dashboard/users`, not here.
 *
 * This roster used to be the "decision 7" exception: it showed the organiser
 * the real name of everybody who checked in to or RSVP'd to their past events,
 * falling back to the label only for somebody with no name set. The CSV export
 * of the same list already used the label, so the screen was the way around
 * the export. `__tests__/attendee-identity-boundary.test.ts` keeps a name from
 * being selected here again.
 */
export interface AttendeeRow {
  /**
   * `attendeeLabel` -- the Attendees export's label, stable for one person
   * across the organisation's events and different at every other
   * organisation. Never the user id: that is the id the room hands out for
   * moderation, and the two together would link a label to a room pseudonym.
   */
  id: string
  attended: number
  rsvps: number
  noShows: number
  lastAttendedAt: string | null
  repeat: boolean
}

export interface AttendeeRoster {
  rows: AttendeeRow[]
  uniqueAttendees: number
  repeatCount: number
  /** Null until there is a past committed RSVP to measure against. */
  noShowPct: number | null
}

/**
 * The organisation's audience: who comes back, and who RSVPs but doesn't show.
 *
 * Scoped by organisation (`eventScopeFor`), not by who created the events --
 * a colleague sees the same roster, and somebody who left sees none.
 */
export async function attendeeRoster(role: user_role, userId: string): Promise<AttendeeRoster> {
  const scope = await eventScopeFor(role, userId)
  const labelScope = await pseudonymScope(role, userId)

  // Ids and times only. Nothing here may select a name, email, image or phone.
  const [checkIns, rsvps] = await Promise.all([
    db.event_check_ins.findMany({
      where: {
        status: { in: ["checked_in", "checked_out"] },
        kind: "attendee",
        event: scope,
      },
      select: { user_id: true, event_id: true, check_in_time: true },
    }),
    db.event_rsvps.findMany({
      where: { status: { in: ["going", "maybe"] }, event: { ...scope, start_time: { lt: new Date() } } },
      select: { user_id: true, event_id: true },
    }),
  ])

  // Assembled in memory rather than SQL: this is bounded by one organiser's
  // audience, and the "attended a given event" join it would otherwise need is
  // a compound key Prisma cannot group by in one call.
  /*
   * Distinct **events**, not check-in rows.
   *
   * `event_check_ins` holds one row per person per day, so a three-day
   * conference counted as three attendances by one person -- and `repeat` below
   * is `attended > 1`, so one attendee at one multi-day event was a returning
   * attendee on the screen whose entire purpose is telling an organiser whether
   * they are building an audience.
   */
  const attendedByUser = new Map<string, { events: Set<string>; last: Date | null }>()
  for (const row of checkIns) {
    const existing = attendedByUser.get(row.user_id)
    const last = row.check_in_time
    const events = existing?.events ?? new Set<string>()
    events.add(row.event_id)
    attendedByUser.set(row.user_id, {
      events,
      last: !existing?.last || (last && last > existing.last) ? last : existing.last,
    })
  }

  const rsvpByUser = new Map<string, number>()
  for (const rsvp of rsvps) {
    rsvpByUser.set(rsvp.user_id, (rsvpByUser.get(rsvp.user_id) ?? 0) + 1)
  }

  // Per (person, event): a walk-in cancels nothing (SCRUM-467).
  const missed = noShows(rsvps, checkIns)

  const userIds = new Set([...attendedByUser.keys(), ...rsvpByUser.keys()])
  const rows: AttendeeRow[] = Array.from(userIds)
    .map((userId) => {
      const attended = attendedByUser.get(userId)
      const rsvpCount = rsvpByUser.get(userId) ?? 0
      const attendedCount = attended?.events.size ?? 0
      return {
        id: attendeeLabel(userId, labelScope),
        attended: attendedCount,
        rsvps: rsvpCount,
        noShows: missed.byUser.get(userId) ?? 0,
        lastAttendedAt: attended?.last?.toISOString() ?? null,
        repeat: attendedCount > 1,
      }
    })
    .sort((a, b) => b.attended - a.attended || b.rsvps - a.rsvps)

  const totalCommitted = rsvps.length

  return {
    rows,
    uniqueAttendees: attendedByUser.size,
    repeatCount: rows.filter((r) => r.repeat).length,
    noShowPct: totalCommitted === 0 ? null : (missed.total / totalCommitted) * 100,
  }
}

/**
 * One person at one event, as whoever runs it sees them: the same label as the
 * organisation's roster and the export, and what they did about this event.
 *
 * No cross-event history. The organiser has that on `/dashboard/attendees`,
 * under this same label.
 */
export interface EventAttendeeRow {
  /** `attendeeLabel`, never the user id. See `AttendeeRow.id`. */
  id: string
  /** A committed RSVP. Null for somebody who walked in without one. */
  rsvp: "going" | "maybe" | null
  /** Their first arrival, across every day of the event. */
  arrivedAt: string | null
  /**
   * `no_show` only once the event is over and only if it ran. Before then a
   * committed RSVP who has not arrived might still come, and nobody fails to
   * turn up to an event that was cancelled.
   */
  status: "came" | "no_show" | "expected"
}

/**
 * What the event's Attendees tab may show this caller (SCRUM-499).
 *
 * - `labels`: whoever runs the event (`canEdit`: its organisation, or an
 *   admin) gets one row per person, by label.
 * - `count`: a venue owner operating an event in their building gets how many
 *   came, and nothing per person. Venues see aggregates, never people (the
 *   owner's venue rulings; SCRUM-501 made their check-ins export the same).
 *   Under `MIN_CELL` the count is held back as null, as that export's is.
 */
export type EventAttendees =
  | { view: "labels"; rows: EventAttendeeRow[]; came: number; walkIns: number; noShows: number }
  | { view: "count"; came: number | null }

const RSVP_RANK = { going: 0, maybe: 1 } as const

/** Door order: arrivals first, earliest first; then going, maybe, and the rest. */
function doorOrder(a: EventAttendeeRow, b: EventAttendeeRow): number {
  if (a.arrivedAt !== b.arrivedAt) {
    if (a.arrivedAt === null) return 1
    if (b.arrivedAt === null) return -1
    return a.arrivedAt < b.arrivedAt ? -1 : 1
  }
  const rank = (r: EventAttendeeRow) => (r.rsvp ? RSVP_RANK[r.rsvp] : 2)
  return rank(a) - rank(b) || a.id.localeCompare(b.id)
}

/**
 * The event's attendees, as `actor` may see them, or null if they may not.
 *
 * Authorised here with `eventPermissions`, the same resolver the page gates on,
 * so a caller that forgets the gate gets nothing rather than another
 * organisation's attendees.
 */
export async function eventAttendees(
  actor: PermissionActor,
  eventId: string,
  now = new Date()
): Promise<EventAttendees | null> {
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: { ...eventPermissionSelect, status: true, end_time: true },
  })
  if (!event) return null
  const { canEdit, canOperate } = eventPermissions(actor, event)
  if (!canOperate) return null

  // Ids and times only. Nothing here may select a name, email, image or phone.
  const checkIns = await db.event_check_ins.findMany({
    where: { event_id: eventId, kind: "attendee", status: { in: ATTENDED } },
    select: { user_id: true, event_id: true, check_in_time: true },
  })

  // One row per person per day, so the first arrival is the earliest of them.
  const arrived = new Map<string, Date | null>()
  for (const row of checkIns) {
    const earlier = arrived.get(row.user_id)
    if (!arrived.has(row.user_id) || (row.check_in_time && (!earlier || row.check_in_time < earlier))) {
      arrived.set(row.user_id, row.check_in_time)
    }
  }

  if (!canEdit) return { view: "count", came: arrived.size < MIN_CELL ? null : arrived.size }

  const [rsvps, labelScope] = await Promise.all([
    db.event_rsvps.findMany({
      where: { event_id: eventId, status: { in: ["going", "maybe"] } },
      select: { user_id: true, event_id: true, status: true },
    }),
    pseudonymScope(actor.role, actor.id),
  ])
  const rsvpOf = new Map(rsvps.map((r) => [r.user_id, r.status as "going" | "maybe"]))

  const over = event.status !== "cancelled" && event.end_time <= now
  // The same per-(person, event) rule as the organisation's roster (SCRUM-467).
  const missed = over ? noShows(rsvps, checkIns).byUser : new Map<string, number>()

  const rows: EventAttendeeRow[] = Array.from(new Set([...arrived.keys(), ...rsvpOf.keys()]))
    .map((person) => {
      const at = arrived.get(person)
      return {
        id: attendeeLabel(person, labelScope),
        rsvp: rsvpOf.get(person) ?? null,
        arrivedAt: at?.toISOString() ?? null,
        status: arrived.has(person) ? "came" : missed.has(person) ? "no_show" : "expected",
      } satisfies EventAttendeeRow
    })
    .sort(doorOrder)

  return {
    view: "labels",
    rows,
    came: arrived.size,
    walkIns: rows.filter((r) => r.status === "came" && r.rsvp === null).length,
    noShows: missed.size,
  }
}
