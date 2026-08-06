import { redirect } from "next/navigation"

import { MetricTile } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
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

  const scope = { deleted_at: null, organizer_id: session.user.id }

  const [checkIns, rsvps] = await Promise.all([
    db.event_check_ins.findMany({
      where: { status: { in: ["checked_in", "checked_out"] }, event: scope },
      select: {
        user_id: true,
        check_in_time: true,
        user: { select: { name: true, email: true } },
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
  const attendedByUser = new Map<string, { count: number; last: Date | null; name: string }>()
  for (const row of checkIns) {
    const existing = attendedByUser.get(row.user_id)
    const last = row.check_in_time
    attendedByUser.set(row.user_id, {
      count: (existing?.count ?? 0) + 1,
      last: !existing?.last || (last && last > existing.last) ? last : existing.last,
      name: row.user.name ?? row.user.email,
    })
  }

  const rsvpByUser = new Map<string, number>()
  for (const rsvp of rsvps) {
    rsvpByUser.set(rsvp.user_id, (rsvpByUser.get(rsvp.user_id) ?? 0) + 1)
  }

  const userIds = new Set([...attendedByUser.keys(), ...rsvpByUser.keys()])
  const missingNames = await db.user.findMany({
    where: { id: { in: Array.from(userIds).filter((id) => !attendedByUser.has(id)) } },
    select: { id: true, name: true, email: true },
  })
  const nameFor = new Map(missingNames.map((u) => [u.id, u.name ?? u.email]))

  const rows: AttendeeRow[] = Array.from(userIds)
    .map((userId) => {
      const attended = attendedByUser.get(userId)
      const rsvpCount = rsvpByUser.get(userId) ?? 0
      const attendedCount = attended?.count ?? 0
      return {
        id: userId,
        name: attended?.name ?? nameFor.get(userId) ?? "Unknown",
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
  const totalAttended = checkIns.length
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
