import { notFound, redirect } from "next/navigation"

import { BuildingOccupancyPanel } from "@/components/dashboard/building-occupancy-panel"
import { MetricTile, RatingBars, SectionTitle } from "@/components/dashboard/primitives"
import { organisationOptions } from "@/lib/onboarding-actions"
import { VenueManage } from "./venue-manage"
import { VenueEventsTable, type VenueEventRow } from "./venue-events-table"
import { getAuth } from "@/lib/auth"
import { getBuildingOccupancy } from "@/lib/building-occupancy"
import { db } from "@/lib/db"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { turnUpPct } from "@/lib/counting"
import { formatNumber, formatPct } from "@/lib/dashboard-format"
import { resolveRange } from "@/lib/date-range"

export const dynamic = "force-dynamic"


/**
 * One venue.
 *
 * `/dashboard/venues` shows a section per venue but there was no way in. A
 * venue owner with eight rooms needs a page per room — what runs there, who
 * runs it, and whether it is worth keeping — and an admin needs the same page
 * plus who owns it.
 *
 * Access is ownership-shaped, not role-shaped: whoever's organisation owns the
 * venue, plus platform admins. An unclaimed venue is admin-only, because there
 * is nobody whose venue it is.
 */
export default async function VenueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ range?: string; from?: string; to?: string }>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const { id } = await params
  const range = resolveRange(await searchParams)

  /*
   * Retired venues load here, and nowhere else.
   *
   * Every other read filters `deleted_at: null` and should — a retired venue is
   * gone from the feed, the search and the pickers. But this is the screen the
   * restore control lives on, so filtering it here would make retirement
   * one-way by accident: the row would exist, be correct, and be unreachable.
   */
  const venue = await db.venues.findUnique({
    where: { id },
    select: {
      id: true,
      updated_at: true,
      name: true,
      address: true,
      city: true,
      capacity: true,
      status: true,
      claimed_at: true,
      deleted_at: true,
      latitude: true,
      longitude: true,
      venue_type: true,
      owner_org: { select: { id: true, display_name: true } },
    },
  })
  if (!venue) notFound()

  const isAdmin = session.user.role === "app_admin"
  if (!isAdmin) {
    const membership = venue.owner_org
      ? await db.organisation_members.findFirst({
          where: { user_id: session.user.id, org_id: venue.owner_org.id },
          select: { id: true },
        })
      : null
    if (!membership) redirect("/dashboard/venues")
  }

  const building = await getBuildingOccupancy(id)

  /*
   * Only fetched when it can be used: an admin, looking at a venue nobody owns.
   * Loading the directory to render a control that will not be shown is the
   * kind of cost that is invisible until the directory is large.
   */
  const ownerOptions =
    isAdmin && !venue.owner_org && !venue.deleted_at
      ? await organisationOptions()
      : { rows: [], total: 0 }

  const [events, ratingRows] = await Promise.all([
    db.events.findMany({
      where: { venue_id: id, deleted_at: null, start_time: { gte: range.from, lt: range.to } },
      orderBy: { start_time: "desc" },
      take: 200,
      select: {
        id: true,
        title: true,
        start_time: true,
        status: true,
        max_capacity: true,
        organizer_org: { select: { display_name: true } },
        organizer: { select: { name: true } },
        _count: {
          select: {
            rsvps: { where: { status: "going" } },
          },
        },
      },
    }),
    db.event_ratings.groupBy({
      by: ["rating"],
      where: { event: { venue_id: id, deleted_at: null } },
      _count: { _all: true },
    }),
  ])

  const ratings: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  for (const row of ratingRows) {
    if (row.rating >= 1 && row.rating <= 5) ratings[row.rating - 1] = row._count._all
  }
  const ratingTotal = ratings.reduce((a, b) => a + b, 0)
  const averageRating =
    ratingTotal === 0
      ? null
      : Math.round((ratings.reduce((sum, n, i) => sum + n * (i + 1), 0) / ratingTotal) * 10) / 10

  /*
   * Attendance is a grouped query, not a `_count`: the table holds one row per
   * person **per day**, so a venue hosting one three-day conference reported
   * three times the people who came through its doors — on the page a venue
   * owner reads for licensing and staffing.
   */
  const attended = await distinctAttendeeCounts(events.map((e) => e.id))

  const rows: VenueEventRow[] = events.map((e) => ({
    id: e.id,
    title: e.title,
    startAt: e.start_time.toISOString(),
    status: e.status,
    // The organising company, falling back to whoever created it — an event
    // predating organisations has no org.
    organiser: e.organizer_org?.display_name ?? e.organizer?.name ?? "—",
    going: e._count.rsvps,
    attended: attended.get(e.id) ?? 0,
    fillPct: e.max_capacity ? Math.round((e._count.rsvps / e.max_capacity) * 100) : null,
  }))

  const totalAttended = rows.reduce((sum, r) => sum + r.attended, 0)
  const totalGoing = rows.reduce((sum, r) => sum + r.going, 0)
  // Uncapped, now that attendance counts people. The cap was framed as absorbing
  // walk-ins and in practice absorbed the row inflation, which hid them.
  const turnUp = turnUpPct(totalAttended, totalGoing)

  const repeatOrganisers = new Map<string, number>()
  for (const r of rows) repeatOrganisers.set(r.organiser, (repeatOrganisers.get(r.organiser) ?? 0) + 1)
  const returning = [...repeatOrganisers.values()].filter((n) => n > 1).length


  // One title line. Status, capacity and owner are words beside the name —
  // none is an action, so none is a chip.
  const titleMeta = [
    venue.deleted_at ? "retired" : venue.status,
    venue.capacity ? `${formatNumber(venue.capacity)} capacity` : null,
    venue.claimed_at
      ? isAdmin && venue.owner_org
        ? venue.owner_org.display_name
        : null
      : // Only an admin ever sees an unclaimed venue, so this is a prompt to
        // act rather than a status nobody can change.
        "unclaimed",
  ].filter(Boolean)
  // The address line without the city repeated: "12th Main Rd, Bengaluru,
  // Bengaluru" is what the seed produces and what an owner types.
  const address =
    venue.address && venue.city && venue.address.endsWith(venue.city)
      ? venue.address
      : [venue.address, venue.city].filter(Boolean).join(" · ")

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2 className="text-[length:var(--text-h2)] font-bold">{venue.name}</h2>
          <span className="text-[0.8125rem] text-muted-foreground">{titleMeta.join(" · ")}</span>
        </div>
        <p className="text-[0.8125rem] text-muted-foreground">
          {address || "No address recorded"}
        </p>
      </div>

      {/* Above the window metrics, deliberately: everything below is about a
          date range someone chose, and this is about right now. */}
      <BuildingOccupancyPanel occupancy={building} />

      <div className="flex flex-wrap gap-1">
        <MetricTile label="Events" value={formatNumber(rows.length)} hint="in this window" />
        <MetricTile label="Attended" value={formatNumber(totalAttended)} hint="GPS check-ins" />
        <MetricTile
          label="Turn-up"
          value={turnUp === null ? null : formatPct(turnUp)}
          hint={turnUp === null ? "needs a past event" : "of committed RSVPs"}
        />
        <MetricTile
          label="Returning organisers"
          value={returning}
          hint={returning === 0 ? "nobody has come back yet" : "booked here more than once"}
        />
      </div>

      <div className="grid gap-8 @3xl/main:grid-cols-[2fr_1fr] @3xl/main:items-start">
        <section className="flex flex-col gap-3 border-t border-border pt-5">
          <SectionTitle hint={rows.length ? `${rows.length} in window` : undefined}>
            Events here
          </SectionTitle>
          <VenueEventsTable rows={rows} />
        </section>
        <section className="flex flex-col gap-3 border-t border-border pt-5">
          <SectionTitle hint={ratingTotal ? `avg ${averageRating} · all-time` : "all-time"}>
            Ratings
          </SectionTitle>
          {ratingTotal === 0 ? (
            <p className="text-[0.8125rem] text-muted-foreground">Nobody has rated an event here yet.</p>
          ) : (
            <RatingBars counts={ratings} />
          )}
        </section>
      </div>

      {/* The record last. "Is the pin right" is the third question a venue
          owner asks of this page, after "how busy" and "who books here" — and
          it used to be the first block, a form above every number. */}
      <VenueManage
        // Remount on every saved change, so the fields show what was stored
        // rather than what was typed — router.refresh() alone left a form
        // seeded once at mount showing the pre-save value.
        key={venue.updated_at.toISOString()}
        orgs={ownerOptions}
        venue={{
          id: venue.id,
          name: venue.name,
          venueType: venue.venue_type,
          address: venue.address,
          city: venue.city,
          capacity: venue.capacity,
          lat: venue.latitude,
          lng: venue.longitude,
          retired: venue.deleted_at !== null,
          ownerOrg: venue.owner_org?.display_name ?? null,
        }}
        isAdmin={isAdmin}
      />
    </div>
  )
}
