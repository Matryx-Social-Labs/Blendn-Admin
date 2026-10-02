import { redirect } from "next/navigation"

import { EventsTable, type EventRow } from "./events-table"
import { getAuth } from "@/lib/auth"
import { mayCreateEvents } from "@/lib/event-ownership"
import { curationState } from "@/lib/curation"
import { whenLabel } from "@/lib/dashboard-format"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { db } from "@/lib/db"
import { discloseVenueCounts } from "@/lib/disclosure"
import { hostsEvent, visibleEventsScope } from "@/lib/event-visibility"
import { canAccessDashboard } from "@/lib/rbac"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/events")

export const dynamic = "force-dynamic"

export default async function EventsPage() {
  const session = await getAuth()
  if (!session?.user || !canAccessDashboard(session.user.role)) redirect("/login")

  const now = new Date()

  /*
   * Resolved once and reused by both the page and the total. Both used to
   * resolve it separately, and for any non-admin viewer that means `actorFor`
   * fires its `organisation_members` lookup twice per render for an answer that
   * cannot have changed in between.
   */
  const { where, actor } = await visibleEventsScope(session.user)

  /*
   * The rows and the total start together; only the attendance counts wait.
   *
   * `count({ where })` needs nothing but `where`, so awaiting the page of rows
   * first cost a full sequential round trip for no reason —
   * `distinctAttendeeCounts` is the only one of the three that genuinely needs
   * the ids. Measured by a latency pass, which found the same shape in
   * `app/api/mobile/events/route.ts`.
   */
  const [events, total] = await Promise.all([
    db.events.findMany({
    where,
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
      // Each row's "when" on its own event's clock, not the server's (SCRUM-496).
      timezone: true,
      city: true,
      venue_name: true,
      latitude: true,
      geofence: true,
      curated_at: true,
      claimed_at: true,
      organizer_id: true,
      organizer_org_id: true,
      organizer: { select: { name: true, email: true } },
      _count: { select: { rsvps: true } },
    },
    }),
    db.events.count({ where }),
  ])

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
  const arrivals = await distinctAttendeeCounts(events.map((event) => event.id))

  /*
   * A venue owner sees another host's event as the venue does: counts under
   * the floor held back, by the rule the venue page and the exports use, so
   * this list cannot print what they blank (SCRUM-501). Their own events, and
   * everybody else's lists, are exact.
   */
  const throughBuilding = new Set(
    session.user.role === "venue_owner"
      ? events.filter((e) => !hostsEvent(actor, e)).map((e) => e.id)
      : []
  )
  const counts = (event: (typeof events)[number]) => {
    const exact = { rsvps: event._count.rsvps, arrivals: arrivals.get(event.id) ?? 0 }
    if (!throughBuilding.has(event.id)) return exact
    const shown = discloseVenueCounts({ going: exact.rsvps, attended: exact.arrivals, capacity: null })
    return { rsvps: shown.going, arrivals: shown.attended }
  }

  const rows: EventRow[] = events.map((event) => ({
    id: event.id,
    title: event.title,
    status: event.status,
    startTime: event.start_time.toISOString(),
    when: whenLabel(event.start_time, event.end_time, now, event.timezone),
    where: event.venue_name ?? event.city ?? null,
    city: event.city,
    host: event.organizer?.name ?? null,
    ...counts(event),
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

  // Only an account that could save the event is offered the button (SCRUM-145).
  const canCreate = await mayCreateEvents(session.user)

  return <EventsTable rows={rows} total={total} canCreate={canCreate} />
}
