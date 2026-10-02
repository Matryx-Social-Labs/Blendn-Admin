import { redirect } from "next/navigation"

import { EventsTable, type EventRow } from "./events-table"
import { getAuth } from "@/lib/auth"
import { mayCreateEvents } from "@/lib/event-ownership"
import { curationState } from "@/lib/curation"
import { eventRowFields } from "@/lib/event-row"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { db } from "@/lib/db"
import { discloseVenueCounts } from "@/lib/disclosure"
import { stillArriving } from "@/lib/occurrences"
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
  const names = session.user.role !== "organizer"

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
      max_capacity: true,
      curated_at: true,
      claimed_at: true,
      organizer_id: true,
      organizer_org_id: true,
      /*
       * Whose night it is: for an admin and for a venue, never for an
       * organiser, whose list is their own organisation's — so it is not even
       * selected for them, and never an email.
       */
      organizer: names ? { select: { name: true } } : false,
      // Going, as every other screen counts it: `not_going` is a decline, and
      // "maybe" is not a seat (the overview's hero names it separately).
      _count: { select: { rsvps: { where: { status: "going" } } } },
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
    const exact = { going: event._count.rsvps, arrivals: arrivals.get(event.id) ?? 0 }
    if (!throughBuilding.has(event.id)) return exact
    const shown = discloseVenueCounts({
      going: exact.going,
      attended: exact.arrivals,
      capacity: null,
      arriving: stillArriving(event, now),
    })
    return { going: shown.going, arrivals: shown.attended }
  }

  const rows: EventRow[] = events.map((event) => ({
    ...eventRowFields(event, now),
    startTime: event.start_time.toISOString(),
    /*
     * Null for a curated listing nobody has claimed: `organizer_id` there is
     * the admin who curated it, and the founder's name must not reach the page
     * payload as its host (T83). The row says "Listed by us" instead.
     */
    host: curationState(event) === "curated_open" ? null : (event.organizer?.name ?? null),
    ...counts(event),
    curation: curationState(event),
  }))

  // Only an account that could save the event is offered the button (SCRUM-145).
  const canCreate = await mayCreateEvents(session.user)

  return <EventsTable rows={rows} total={total} canCreate={canCreate} />
}
