import Link from "next/link"
import { redirect } from "next/navigation"
import { IconAlertTriangle, IconBuildingStore, IconCalendar } from "@tabler/icons-react"

import { EmptyState, MetricTile, RatingBars } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getAuth } from "@/lib/auth"
import { formatDay, formatNumber } from "@/lib/dashboard-format"

import { getLinkedEventsForOwner } from "@/lib/venue-link-actions"

import { getDashboardOverview, getVenueRecords } from "../actions"
import { LinkedEvents } from "./linked-events"
import { VenueRecords } from "./venue-records"

export const dynamic = "force-dynamic"

const toneVariant = {
  success: "default",
  neutral: "secondary",
  destructive: "destructive",
} as const

/**
 * Venue owner: one section per venue, never blended.
 *
 * Reuses the venue-owner overview payload — the overview shows the comparison
 * table and this screen expands each row, so recomputing would be two versions
 * of the same arithmetic that could drift apart.
 */
export default async function MyVenuesPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  /*
   * Admins get the record index; owners get their utilisation view.
   *
   * `dashboard-nav.ts` has promised admins "every venue record — who owns
   * each, which are unclaimed" since it was written, and pointed at
   * `/dashboard/venue-owners`, a list of *user accounts*. So the one role that
   * can see every venue could see none of them: this route redirected them
   * away, which also killed the venue detail page's own "← All venues" link
   * for the only role that has a use for it.
   *
   * One route, two readings, because they are the same noun — and the detail
   * page both roles land on is already shared.
   */
  if (session.user.role === "app_admin") {
    return <VenueRecords venues={await getVenueRecords()} />
  }
  if (session.user.role !== "venue_owner") redirect("/dashboard")

  const [overview, linkedEvents] = await Promise.all([
    getDashboardOverview(),
    // Read from events.venue_id, not the venue_name grouping below — this is
    // the real link, and it is what grants the owner operational access.
    getLinkedEventsForOwner(),
  ])
  if (overview.role !== "venue_owner") redirect("/dashboard")

  if (overview.venues.length === 0 && linkedEvents.length === 0) {
    return (
      <EmptyState
        icon={<IconBuildingStore />}
        title="No venues yet"
        description="Add your venue and events held there inherit its location, capacity and check-in area. Sections here are still built from the venue name on each event, so a venue with no events yet stays quiet until one runs."
        action={
          <Button asChild>
            <Link href="/dashboard/venues/new">Add a venue</Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Only the part a reader cannot deduce from the grouping itself: some
            events are attached to a venue record and some are still just a
            string, and those two group differently. */}
        <p className="max-w-prose text-[0.8125rem] text-muted-foreground">
          Events still on a free-text venue name are grouped by that name, ignoring case
          and spacing.
        </p>
        <Button asChild>
          <Link href="/dashboard/venues/new">Add a venue</Link>
        </Button>
      </div>

      <LinkedEvents events={linkedEvents} />

      {overview.venues.map((venue) => {
        const lowSkew = venue.ratings[0] + venue.ratings[1] > venue.ratings[3] + venue.ratings[4]
        return (
          <section
            key={venue.name}
            className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[length:var(--text-h2)] font-bold">{venue.name}</h2>
              <Badge variant={toneVariant[venue.tone]}>{venue.note}</Badge>
            </div>

            <div className="flex flex-wrap gap-1">
              <MetricTile
                label="Nights/week"
                value={venue.nightsPerWeek}
                hint="last 8 weeks"
              />
              <MetricTile label="Events (8w)" value={venue.eventsInWindow} />
              <MetricTile
                label="Capacity"
                value={venue.capacityProxy}
                hint={venue.capacityProxy === null ? "none declared" : "largest declared"}
              />
              <MetricTile label="Avg rating" value={venue.averageRating} />
            </div>

            <div className="grid gap-5 @2xl/main:grid-cols-2">
              {venue.ratings.every((n) => n === 0) ? (
                <EmptyState
                  compact
                  description="No ratings for events at this venue yet."
                />
              ) : (
                <RatingBars counts={venue.ratings} />
              )}

              {venue.nextBooking ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    Next booking
                  </p>
                  <Link
                    href={`/dashboard/events/${venue.nextBooking.id}`}
                    className="rounded-lg border border-border p-3 transition-colors hover:bg-accent"
                  >
                    <p className="font-medium">{venue.nextBooking.name}</p>
                    <p className="text-[0.8125rem] text-muted-foreground">
                      {formatDay(venue.nextBooking.startAt)} ·{" "}
                      {formatNumber(venue.nextBooking.going)} going
                    </p>
                  </Link>
                </div>
              ) : (
                <EmptyState
                  compact
                  icon={<IconCalendar />}
                  description="No upcoming bookings for this room — it drops off organisers' radar without listed availability."
                />
              )}
            </div>

            {lowSkew ? (
              <p className="flex items-start gap-2 text-[0.8125rem] text-destructive">
                <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
                Ratings skew low here across different events — likely a facilities problem
                rather than an event problem.
              </p>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
