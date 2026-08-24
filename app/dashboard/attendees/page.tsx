import { redirect } from "next/navigation"

import { MetricTile } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { attendeeLabel } from "@/lib/pseudonym"
import { eventScopeFor, pseudonymScope } from "@/lib/reports"
import { formatNumber, formatPct } from "@/lib/dashboard-format"

import { AttendeesTable, type AttendeeRow } from "./attendees-table"

export const dynamic = "force-dynamic"

/**
 * Organiser: who comes back, and who RSVPs but doesn't show.
 *
 * Repeat attendance is the loyalty signal and no-shows are the capacity
 * planning one; neither had a home before this screen.
 */
export default async function AttendeesPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role === "app_admin") redirect("/dashboard/users")
  if (session.user.role !== "organizer") redirect("/dashboard")

  /*
   * The organisation's events, not the ones this person happens to have created.
   *
   * `{ organizer_id: session.user.id }` is the hand-rolled scoping CLAUDE.md
   * exists to end: a colleague at the same organisation saw an empty roster for
   * events their own org runs, and somebody who has left kept theirs. The
   * exports have used `eventScopeFor` for this since they were written; this
   * screen re-derived it and got a different answer.
   *
   * `__tests__/authz-scoping-boundary.test.ts` did not catch it, because it
   * scans for a hand-rolled `organizer_id !==` comparison and this is a
   * `where` clause. Worth widening.
   */
  const scope = await eventScopeFor(session.user.role, session.user.id)
  const labelScope = await pseudonymScope(session.user.role, session.user.id)

  const [checkIns, rsvps] = await Promise.all([
    db.event_check_ins.findMany({
      where: {
        status: { in: ["checked_in", "checked_out"] },
        kind: "attendee",
        event: scope,
      },
      select: {
        user_id: true,
        event_id: true,
        check_in_time: true,
        user: { select: { name: true } },
      },
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
   *
   * This screen was missed by the counting sweep because it never used
   * `_count`: it incremented in a loop, which the boundary test cannot see.
   */
  const attendedByUser = new Map<
    string,
    { events: Set<string>; last: Date | null; name: string | null }
  >()
  for (const row of checkIns) {
    const existing = attendedByUser.get(row.user_id)
    const last = row.check_in_time
    const events = existing?.events ?? new Set<string>()
    events.add(row.event_id)
    attendedByUser.set(row.user_id, {
      events,
      last: !existing?.last || (last && last > existing.last) ? last : existing.last,
      /*
       * Never the email address. This was `name ?? email`, so an attendee who
       * had not set a name handed the organiser a way to contact them off
       * platform -- where there is no block, no report and no record. Decision 7
       * is explicit: organisers see real names, never email addresses.
       */
      name: row.user.name,
    })
  }

  const rsvpByUser = new Map<string, number>()
  for (const rsvp of rsvps) {
    rsvpByUser.set(rsvp.user_id, (rsvpByUser.get(rsvp.user_id) ?? 0) + 1)
  }

  const userIds = new Set([...attendedByUser.keys(), ...rsvpByUser.keys()])
  const missingNames = await db.user.findMany({
    where: { id: { in: Array.from(userIds).filter((id) => !attendedByUser.has(id)) } },
    select: { id: true, name: true },
  })
  const nameFor = new Map(missingNames.map((u) => [u.id, u.name]))

  const rows: AttendeeRow[] = Array.from(userIds)
    .map((userId) => {
      const attended = attendedByUser.get(userId)
      const rsvpCount = rsvpByUser.get(userId) ?? 0
      const attendedCount = attended?.events.size ?? 0
      /*
       * The pseudonym, not the user id.
       *
       * The row carried the raw `user_id` into the client payload -- readable
       * in the network tab, and the same id the chat participants list hands
       * out, which is what turns a pseudonymous room back into named people.
       * The same label the CSV export uses, so the two agree and neither is a
       * way to recover the other.
       */
      const label = attendeeLabel(userId, labelScope)
      return {
        id: label,
        // Falls back to the label rather than "Unknown": an attendee with no
        // name still needs to be distinguishable from the next one.
        name: attended?.name ?? nameFor.get(userId) ?? label,
        attended: attendedCount,
        rsvps: rsvpCount,
        // Floored at zero: walk-ins attend without an RSVP, so attended can
        // legitimately exceed RSVPs and a negative no-show count is nonsense.
        noShows: Math.max(0, rsvpCount - attendedCount),
        lastAttendedAt: attended?.last?.toISOString() ?? null,
        repeat: attendedCount > 1,
      }
    })
    .sort((a, b) => b.attended - a.attended || b.rsvps - a.rsvps)

  const uniqueAttendees = attendedByUser.size
  const repeatCount = rows.filter((r) => r.repeat).length
  const totalCommitted = rsvps.length
  // People, not rows. See the fold above.
  const totalAttended = Array.from(attendedByUser.values()).reduce((n, a) => n + a.events.size, 0)
  const noShowPct =
    totalCommitted === 0 ? null : Math.max(0, 100 - (Math.min(totalAttended, totalCommitted) / totalCommitted) * 100)


  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-1">
        <MetricTile label="Unique attendees" value={formatNumber(uniqueAttendees)} />
        <MetricTile
          label="Came back"
          value={repeatCount}
          hint={
            uniqueAttendees === 0
              ? "needs 2+ events"
              : `${Math.round((repeatCount / uniqueAttendees) * 100)}% of attendees`
          }
        />
        <MetricTile
          label="No-show rate"
          value={noShowPct === null ? null : formatPct(noShowPct)}
          hint={noShowPct === null ? "needs a past event" : "committed RSVPs who didn't check in"}
        />
      </div>

      <AttendeesTable rows={rows} />
    </div>
  )
}
