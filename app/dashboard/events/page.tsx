import { redirect } from "next/navigation"

import { EventsTable, type EventRow } from "./events-table"
import { getAuth } from "@/lib/auth"
import { curationState } from "@/lib/curation"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { db } from "@/lib/db"
import { visibleEventsWhere } from "@/lib/event-visibility"
import { canAccessDashboard } from "@/lib/rbac"

export const dynamic = "force-dynamic"

/**
 * One column for when, not two.
 *
 * Start and end were separate columns each rendering the full
 * "Sep 9, 2026, 11:57 AM" — the year twice and the date twice on every row, for
 * a fact that is one date and a duration. At seventeen rows that is a quarter
 * of the table's width spent repeating 2026.
 *
 * Formatted here rather than in the client component for two reasons that are
 * really one: `new Date()` inside a render is an impure call (the React
 * Compiler says so), and server and client can disagree about the year across
 * a New Year boundary, which is a hydration mismatch nobody will ever
 * reproduce. Same fix as `generatedAt` on the overview — compute it once, on
 * the server, and send the string.
 */
function whenLabel(start: Date, end: Date, now: Date): string {
  const sameDay = start.toDateString() === end.toDateString()
  const date = start.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    // The year only when it is not this one. A list of 2026 events read on a
    // 2026 afternoon does not need telling.
    ...(start.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })
  if (!sameDay) {
    return `${date} → ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
  }
  const from = start.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" })
  return `${date}, ${from}`
}

/**
 * Every event this person may see.
 *
 * ## Why this is a server component now
 *
 * It was the last screen in the dashboard that fetched its own data from a
 * client `useEffect`, and that one decision produced most of what was wrong
 * with it: a **"Loading events…" spinner inside a bordered card**, on a
 * codebase whose design system says skeletons rather than spinners and which
 * already had `app/dashboard/events/loading.tsx` sitting unused — the boundary
 * can never fire for a component that does not suspend.
 *
 * It also meant a second copy of the row shape, and a second answer to "which
 * events may I see": the route it called had careful organisation-membership
 * scoping with a comment explaining the colleague-sees-an-empty-list bug, and
 * nothing held the dashboard to it. `lib/event-visibility.ts` is now the only
 * answer, used by both.
 *
 * ## What the columns are for
 *
 * An admin opens this to find one event, or to see what is broken. So: when,
 * where, whose, and whether it can actually be checked into. **Capacity is
 * gone** — it rendered `current_capacity`, which has no application writer and
 * was `0` on every row for every event ever created (K4.12). A column of zeroes
 * is not a neutral omission; it is a metric asserting that nobody came.
 */
export default async function EventsPage() {
  const session = await getAuth()
  if (!session?.user || !canAccessDashboard(session.user.role)) redirect("/login")

  const now = new Date()

  const events = await db.events.findMany({
    where: await visibleEventsWhere(session.user),
    orderBy: { start_time: "desc" },
    // Bounded, and the count below says so rather than letting a truncated
    // list read as the whole list — the no-silent-caps rule, applied to the UI.
    take: 200,
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      start_time: true,
      end_time: true,
      city: true,
      venue_name: true,
      latitude: true,
      geofence: true,
      curated_at: true,
      claimed_at: true,
      organizer_org_id: true,
      organizer: { select: { name: true, email: true } },
      _count: { select: { rsvps: true } },
    },
  })

  /*
   * Arrivals are DISTINCT PEOPLE, from the module that owns the question.
   *
   * The first version of this select had `_count: { check_ins: true }` and
   * `__tests__/count-people-boundary.test.ts` failed the build on it, which is
   * exactly what that guard is for. A check-in row is a person-day: one
   * attendee at "Design Week Bengaluru" — three days, in the seed — would have
   * rendered as 3 arrivals on this list while the funnel one screen away
   * counted them once. That is W17 in a tenth place, on a screen built after
   * W17 shipped.
   */
  const [total, arrivals] = await Promise.all([
    db.events.count({ where: await visibleEventsWhere(session.user) }),
    distinctAttendeeCounts(events.map((event) => event.id)),
  ])

  const rows: EventRow[] = events.map((event) => ({
    id: event.id,
    title: event.title,
    status: event.status,
    startTime: event.start_time.toISOString(),
    when: whenLabel(event.start_time, event.end_time, now),
    where: event.venue_name ?? event.city ?? null,
    city: event.city,
    host: event.organizer?.name ?? null,
    rsvps: event._count.rsvps,
    arrivals: arrivals.get(event.id) ?? 0,
    curation: curationState(event),
    /*
     * The one thing that decides whether the door works.
     *
     * `canPublish` refuses an event with no coordinates and no fence, and it
     * only reached a caller recently — so published events predating that exist
     * and 400 at the door with nothing on any screen saying why. Surfacing it
     * on the list is how you find them without opening 200 events.
     */
    checkInReady: event.latitude !== null || event.geofence !== null,
  }))

  const canCreate = session.user.role === "app_admin" || session.user.role === "organizer"

  return <EventsTable rows={rows} total={total} canCreate={canCreate} />
}
