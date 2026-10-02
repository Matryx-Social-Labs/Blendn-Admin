import { ATTENDED, noShows } from "./counting"
import type { rsvp_status, user_role } from "@prisma/client"

import { distinctAttendeeCounts } from "./attendee-counts"
import { db } from "./db"
import { discloseVenueCounts, liveCountBucket, MIN_CELL, type LiveCountBucket } from "./disclosure"
import { attendeeLabel } from "./pseudonym"
import { eventPermissionSelect, eventPermissions, type PermissionActor } from "./rbac"
import { eventScopeFor, labelScopeFor, labelScoper } from "./reports"

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
   * `attendeeLabel`, salted with the event's organisation (`labelScopeFor`) --
   * the Attendees export's label, stable for one person across that
   * organisation's events and different at every other organisation. Never the
   * user id: that is the id the room hands out for moderation, and the two
   * together would link a label to a room pseudonym.
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
  /** Null until there is a committed RSVP to an event that is over to measure against. */
  noShowPct: number | null
}

/** An RSVP that counts as a promise to come. */
function isCommitted(status: rsvp_status): status is "going" | "maybe" {
  return status === "going" || status === "maybe"
}

/**
 * When a committed RSVP without a check-in is a no-show: the event is over, and
 * it ran. Before the end they might still come, and nobody fails to turn up to
 * a cancelled event.
 *
 * Both rosters ask this, the organisation's in SQL and the event's in memory,
 * so a label never reads as a no-show on one and not the other.
 */
const isOverAndRan = (event: { status: string; end_time: Date }, now: Date) =>
  event.status !== "cancelled" && event.end_time <= now
const overAndRanWhere = (now: Date) => ({ end_time: { lte: now }, status: { not: "cancelled" as const } })

/**
 * The organisation's audience: who comes back, and who RSVPs but doesn't show.
 *
 * Scoped by organisation (`eventScopeFor`), not by who created the events --
 * a colleague sees the same roster, and somebody who left sees none.
 */
export async function attendeeRoster(role: user_role, userId: string, now = new Date()): Promise<AttendeeRoster> {
  const scope = await eventScopeFor(role, userId)
  const labelScope = await labelScoper(role, userId)
  const orgOf = { event: { select: { organizer_org_id: true } } } as const

  // Ids and times only. Nothing here may select a name, email, image or phone.
  const [checkIns, rsvps, staff] = await Promise.all([
    db.event_check_ins.findMany({
      where: { status: { in: ATTENDED }, kind: "attendee", event: scope },
      select: { user_id: true, event_id: true, check_in_time: true, ...orgOf },
    }),
    db.event_rsvps.findMany({
      where: { status: { in: ["going", "maybe"] }, event: { ...scope, ...overAndRanWhere(now) } },
      select: { user_id: true, event_id: true, ...orgOf },
    }),
    db.event_check_ins.findMany({
      where: { kind: "staff", event: scope },
      select: { user_id: true, event_id: true },
    }),
  ])

  // Somebody who RSVP'd and then worked the event did not fail to come.
  const worked = new Set(staff.map((s) => `${s.user_id}|${s.event_id}`))
  const label = (row: { user_id: string; event: { organizer_org_id: string | null } }) =>
    attendeeLabel(row.user_id, labelScope(row.event.organizer_org_id))
  const came = checkIns.map((row) => ({ ...row, label: label(row) }))
  const promised = rsvps
    .filter((r) => !worked.has(`${r.user_id}|${r.event_id}`))
    .map((row) => ({ ...row, label: label(row) }))

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
  const attendedBy = new Map<string, { events: Set<string>; last: Date | null }>()
  for (const row of came) {
    const existing = attendedBy.get(row.label)
    const last = row.check_in_time
    const events = existing?.events ?? new Set<string>()
    events.add(row.event_id)
    attendedBy.set(row.label, {
      events,
      last: !existing?.last || (last && last > existing.last) ? last : existing.last,
    })
  }

  const rsvpsBy = new Map<string, number>()
  for (const rsvp of promised) rsvpsBy.set(rsvp.label, (rsvpsBy.get(rsvp.label) ?? 0) + 1)

  // Per (person, event): a walk-in cancels nothing (SCRUM-467). Keyed by label,
  // which is one person within one organisation.
  const byLabel = (rows: { label: string; event_id: string }[]) =>
    rows.map((r) => ({ user_id: r.label, event_id: r.event_id }))
  const missed = noShows(byLabel(promised), byLabel(came))

  const rows: AttendeeRow[] = Array.from(new Set([...attendedBy.keys(), ...rsvpsBy.keys()]))
    .map((id) => {
      const attended = attendedBy.get(id)
      const attendedCount = attended?.events.size ?? 0
      return {
        id,
        attended: attendedCount,
        rsvps: rsvpsBy.get(id) ?? 0,
        noShows: missed.byUser.get(id) ?? 0,
        lastAttendedAt: attended?.last?.toISOString() ?? null,
        repeat: attendedCount > 1,
      }
    })
    .sort((a, b) => b.attended - a.attended || b.rsvps - a.rsvps)

  return {
    rows,
    uniqueAttendees: attendedBy.size,
    repeatCount: rows.filter((r) => r.repeat).length,
    noShowPct: promised.length === 0 ? null : (missed.total / promised.length) * 100,
  }
}

/**
 * One person at one event, as whoever runs it sees them: the label the
 * organisation's roster and the export use, and what they did about this event.
 *
 * No cross-event history, and nothing finer than a quarter of an hour. The
 * room tells everyone in it who checked in and when, under a room pseudonym
 * (`event:room:checkin`); an arrival to the minute would let a host match that
 * pseudonym to this label, which is the link `lib/pseudonym.ts` exists to
 * prevent.
 */
export interface EventAttendeeRow {
  /** `attendeeLabel`, never the user id. See `AttendeeRow.id`. */
  id: string
  /** A committed RSVP. Null for somebody who came without one. */
  rsvp: "going" | "maybe" | null
  /** Their first arrival, across every day of the event, to the quarter hour. */
  arrivedAt: string | null
  /**
   * `no_show` only once the event is over and only if it ran. `held_back` for
   * every row while fewer than `MIN_CELL` came: then who came, and when, would
   * point at people.
   */
  status: "came" | "no_show" | "expected" | "held_back"
}

/**
 * What the event's Attendees tab may show this caller (SCRUM-499).
 *
 * - `labels`: whoever runs the event (`canEdit`: any member of its
 *   organisation, staff included, or an admin) gets a row per person, by label.
 * - `count`: a venue owner operating an event in their building gets how many
 *   came, and nothing per person -- venues see aggregates, never people
 *   (SCRUM-501). Held back as null by `venueCounts`.
 */
export type EventAttendees =
  | {
      view: "labels"
      rows: EventAttendeeRow[]
      came: number
      /** Null while held back. */
      walkIns: number | null
      noShows: number | null
    }
  /** `came` is a range while the event runs: it is still moving (SCRUM-516). */
  | { view: "count"; started: boolean; came: number | LiveCountBucket | null }

const QUARTER_HOUR_MS = 15 * 60_000

const toQuarterHour = (at: Date) => new Date(Math.floor(at.getTime() / QUARTER_HOUR_MS) * QUARTER_HOUR_MS)

/**
 * Everybody on one event's list, as ids: who came (with their first arrival)
 * and who promised to. Staff are neither: an RSVP from somebody who then worked
 * the event is not a promise to attend it.
 */
async function eventPeople(eventId: string) {
  const [arrivals, rsvps, staff] = await Promise.all([
    db.event_check_ins.groupBy({
      by: ["user_id"],
      where: { event_id: eventId, kind: "attendee", status: { in: ATTENDED } },
      _min: { check_in_time: true },
    }),
    db.event_rsvps.findMany({
      where: { event_id: eventId, status: { in: ["going", "maybe"] } },
      select: { user_id: true, status: true },
    }),
    db.event_check_ins.groupBy({ by: ["user_id"], where: { event_id: eventId, kind: "staff" } }),
  ])
  const worked = new Set(staff.map((s) => s.user_id))
  const committed = new Map<string, "going" | "maybe">()
  for (const r of rsvps) if (!worked.has(r.user_id) && isCommitted(r.status)) committed.set(r.user_id, r.status)
  const arrived = new Map(arrivals.map((a) => [a.user_id, a._min.check_in_time]))
  return { arrived, committed }
}

/**
 * An event's Going, Came and fill as the venue it is held at is told them.
 *
 * `discloseVenueCounts`, with the inputs every other venue surface gives it --
 * the going RSVPs and the distinct guests who came -- so the Events list, the
 * venue page, the exports, this Overview and this Attendees tab cannot print
 * what another holds back (SCRUM-501). Zero is shown: it names nobody.
 *
 * `cameSoFar` is the same people as a range, for while the night still runs:
 * a count that moves by one as each person arrives says who just did, floor
 * or no floor (SCRUM-516, D-19).
 */
export async function venueCounts(
  eventId: string,
  capacity: number | null = null
): Promise<{ going: number | null; came: number | null; fillPct: number | null; cameSoFar: LiveCountBucket }> {
  const [going, arrivals] = await Promise.all([
    db.event_rsvps.count({ where: { event_id: eventId, status: "going" } }),
    distinctAttendeeCounts([eventId]),
  ])
  const came = arrivals.get(eventId) ?? 0
  const shown = discloseVenueCounts({ going, attended: came, capacity })
  return {
    going: going === 0 ? 0 : shown.going,
    came: came === 0 ? 0 : shown.attended,
    fillPct: shown.fillPct,
    cameSoFar: liveCountBucket(came),
  }
}

/**
 * The event's attendees, as `actor` may see them, or null if they may not.
 *
 * Authorised here with `eventPermissions`, the same resolver the page gates on,
 * so a caller that forgets the gate gets nothing rather than another
 * organisation's attendees -- and a venue owner nothing for an event before
 * their claim.
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
  // `canViewAttendees`, not `canOperate`: a venue day's owner moderates its
  // room and is never given its attendee list, labels or count (F1, D-1).
  const { canEdit, canViewAttendees } = eventPermissions(actor, event)
  if (!canViewAttendees) return null

  if (!canEdit) {
    const counts = await venueCounts(eventId)
    const running = event.start_time <= now && now < event.end_time
    return { view: "count", started: event.start_time <= now, came: running ? counts.cameSoFar : counts.came }
  }

  // Ids and times only. Nothing here may select a name, email, image or phone.
  const { arrived, committed } = await eventPeople(eventId)

  const scope = labelScopeFor(actor, event.organizer_org_id)
  const came = arrived.size
  const byLabel = (a: EventAttendeeRow, b: EventAttendeeRow) => a.id.localeCompare(b.id)

  if (came > 0 && came < MIN_CELL) {
    // Who promised, and nothing about who came: that would name the few who did.
    return {
      view: "labels",
      rows: Array.from(committed, ([person, rsvp]) => ({
        id: attendeeLabel(person, scope),
        rsvp,
        arrivedAt: null,
        status: "held_back" as const,
      })).sort(byLabel),
      came,
      walkIns: null,
      noShows: null,
    }
  }

  const over = isOverAndRan(event, now)
  const rows: EventAttendeeRow[] = Array.from(new Set([...arrived.keys(), ...committed.keys()]))
    .map((person) => {
      const at = arrived.get(person)
      return {
        id: attendeeLabel(person, scope),
        rsvp: committed.get(person) ?? null,
        arrivedAt: at ? toQuarterHour(at).toISOString() : null,
        status: arrived.has(person) ? "came" : over ? "no_show" : "expected",
      } satisfies EventAttendeeRow
    })
    // By label, not by arrival: door order is the arrival time again.
    .sort(byLabel)

  return {
    view: "labels",
    rows,
    came,
    walkIns: rows.filter((r) => r.status === "came" && r.rsvp === null).length,
    noShows: rows.filter((r) => r.status === "no_show").length,
  }
}
