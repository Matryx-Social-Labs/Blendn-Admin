import { Suspense } from "react"
import { notFound, redirect } from "next/navigation"

import { DateRangeControl } from "@/components/date-range-control"
import { PageHeader } from "@/components/dashboard/page-header"
import { venueTitleFor } from "@/lib/dashboard-record-titles"
import { BuildingOccupancyPanel } from "@/components/dashboard/building-occupancy-panel"
import { KpiStrip, Panel } from "@/components/dashboard/kit"
import { RatingBars } from "@/components/dashboard/primitives"
import { organisationOptions } from "@/lib/onboarding-actions"
import { VenueManage } from "./venue-manage"
import { VenueEventsTable, type VenueEventRow } from "./venue-events-table"
import { getAuth } from "@/lib/auth"
import { getBuildingOccupancy } from "@/lib/building-occupancy"
import { db } from "@/lib/db"
import { discloseStarsAcross, discloseVenueCounts, spreadsByEvent } from "@/lib/disclosure"
import { stillArriving } from "@/lib/occurrences"
import { claimedWindow, hostsEvent } from "@/lib/event-visibility"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { turnUpPct } from "@/lib/counting"
import { formatNumber, formatPct } from "@/lib/dashboard-format"
import { resolveRange } from "@/lib/date-range"
import { activeMembership, actorFor } from "@/lib/org-membership"
import { venueTypeLabel } from "@/lib/venue-types"
import { realEventsWhere } from "@/lib/event-kind"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: (await venueTitleFor((await params).id)) ?? "Venue" }
}

/**
 * One venue.
 *
 * `/dashboard/venues` shows a section per venue but there was no way in. A
 * venue owner with eight rooms needs a page per room — what runs there, who
 * runs it, and whether it is worth keeping — and an admin needs the same page
 * plus who owns it.
 *
 * Access is ownership-shaped, not role-shaped: whoever's organisation owns the
 * venue, plus platform admins. An unclaimed venue is also open to the
 * organisation that added it (owner's ruling 2, SCRUM-352) — but only its
 * record: the events held there belong to their organisers, and the history is
 * nobody's until a claim (ruling 1), so that view stops at the record
 * (SCRUM-361).
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
      geofence: true,
      floors: true,
      created_by_org_id: true,
      owner_org: { select: { id: true, display_name: true } },
    },
  })
  if (!venue) notFound()

  const isAdmin = session.user.role === "app_admin"
  const memberOf = (orgId: string) =>
    db.organisation_members.findFirst({
      where: { user_id: session.user.id, org_id: orgId, ...activeMembership },
      select: { id: true },
    })
  const record = {
    id: venue.id,
    name: venue.name,
    venueType: venue.venue_type,
    address: venue.address,
    city: venue.city,
    capacity: venue.capacity,
    lat: venue.latitude,
    lng: venue.longitude,
    geofence: venue.geofence,
    retired: venue.deleted_at !== null,
    ownerOrg: venue.owner_org?.display_name ?? null,
    floors: venue.floors,
  }

  if (!isAdmin && !(venue.owner_org && (await memberOf(venue.owner_org.id)))) {
    // Not the owner: the organisation that added it may correct the place
    // while nobody has claimed it, and sees nothing else (SCRUM-361).
    const creator =
      !venue.owner_org && !venue.deleted_at && venue.created_by_org_id
        ? await memberOf(venue.created_by_org_id)
        : null
    if (!creator) redirect("/dashboard/venues")
    return (
      <div className="flex flex-col gap-5">
        {/* No date range: this view has no numbers. */}
        <VenueHeader
          name={venue.name}
          meta={[venueTypeLabel(venue.venue_type), venue.city, "unclaimed — added by your organisation"]
            .filter(Boolean)
            .join(" · ")}
          line="You can correct this place until someone claims it. The events held here stay with the organisers who hold them."
        />
        <VenueManage
          key={venue.updated_at.toISOString()}
          orgs={{ rows: [], total: 0 }}
          venue={record}
          isAdmin={false}
          canRetire={false}
        />
      </div>
    )
  }

  /*
   * The owner sees the venue from its claim on, and an admin sees all of it
   * (SCRUM-355, SCRUM-500). Events, ratings and the live count read through
   * the same window; no claim date on an owned venue is bad data and shows no
   * history at all. `undefined` is the admin's "no window".
   */
  const since = isAdmin ? undefined : claimedWindow(venue)
  const inRange = isAdmin
    ? { gte: range.from, lt: range.to }
    : claimedWindow(venue, { from: range.from, to: range.to })
  const actor = isAdmin ? null : await actorFor(session.user)

  const building = await getBuildingOccupancy(id, { asOwner: actor })

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
      // The nights hosts ran here. The venue's own daily live rooms are not
      // among them; what happens in those reaches the owner as aggregates only.
      where: inRange ? { venue_id: id, deleted_at: null, ...realEventsWhere, start_time: inRange } : { id: { in: [] } },
      orderBy: { start_time: "desc" },
      take: 200,
      select: {
        id: true,
        title: true,
        start_time: true,
        end_time: true,
        status: true,
        max_capacity: true,
        organizer_id: true,
        organizer_org_id: true,
        organizer_org: { select: { display_name: true } },
        organizer: { select: { name: true } },
        _count: {
          select: {
            rsvps: { where: { status: "going" } },
          },
        },
      },
    }),
    // Per event, so the total pools only events that could show their own.
    db.event_ratings.groupBy({
      by: ["event_id", "rating"],
      where:
        since === null
          ? { id: { in: [] } }
          : { event: { venue_id: id, deleted_at: null, ...realEventsWhere, ...(since ? { start_time: since } : {}) } },
      _count: { _all: true },
    }),
  ])

  // Withheld under five raters, and pooled only from events that pass alone,
  // like every rating a host sees (SCRUM-437).
  const { ratings, averageRating, ratingCount: ratingTotal } = discloseStarsAcross(spreadsByEvent(ratingRows))

  /*
   * Attendance is a grouped query, not a `_count`: the table holds one row per
   * person **per day**, so a venue hosting one three-day conference reported
   * three times the people who came through its doors — on the page a venue
   * owner reads for licensing and staffing.
   */
  const attended = await distinctAttendeeCounts(events.map((e) => e.id))

  const rows: VenueEventRow[] = events.map((e) => {
    const exact = {
      going: e._count.rsvps,
      attended: attended.get(e.id) ?? 0,
      fillPct: e.max_capacity ? Math.round((e._count.rsvps / e.max_capacity) * 100) : null,
    }
    return {
      id: e.id,
      title: e.title,
      startAt: e.start_time.toISOString(),
      status: e.status,
      // The organising company, falling back to whoever created it — an event
      // predating organisations has no org.
      organiser: e.organizer_org?.display_name ?? e.organizer?.name ?? "—",
      // Another host's night, seen as the venue: counts held back under the
      // floor, by the rule the Events list and the exports use (SCRUM-501).
      ...(actor && !hostsEvent(actor, e)
        ? discloseVenueCounts({ ...exact, capacity: e.max_capacity, arriving: stillArriving(e) })
        : exact),
    }
  })

  /*
   * The tiles add up only what the rows show. A total over every night would
   * hand back a held-back one by subtraction — the sum minus the visible
   * cells — so a night with a blank cell is out of both sides of turn-up.
   */
  const shown = rows.filter(
    (r): r is VenueEventRow & { going: number; attended: number } => r.going !== null && r.attended !== null
  )
  const heldBack = shown.length < rows.length
  // Every night held back: no figure to add up, and "0" would say nobody came.
  const nothingShown = heldBack && shown.length === 0
  const totalAttended = shown.reduce((sum, r) => sum + r.attended, 0)
  const totalGoing = shown.reduce((sum, r) => sum + r.going, 0)
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
      <VenueHeader name={venue.name} meta={titleMeta.join(" · ")} line={address || "No address recorded"} ranged />

      {/* Above the window metrics, deliberately: everything below is about a
          date range someone chose, and this is about right now. */}
      <BuildingOccupancyPanel occupancy={building} />

      <KpiStrip
        items={[
          { label: "Events", value: formatNumber(rows.length), hint: "in this window" },
          {
            label: "Attended",
            value: formatNumber(nothingShown ? null : totalAttended),
            hint: heldBack ? "GPS check-ins · held-back nights left out" : "GPS check-ins",
          },
          {
            label: "Turn-up",
            value: turnUp === null ? null : formatPct(turnUp),
            hint: nothingShown ? "held back" : turnUp === null ? "needs a past event" : "of committed RSVPs",
          },
          {
            label: "Returning organisers",
            value: returning,
            hint: returning === 0 ? "nobody has come back yet" : "booked here more than once",
          },
        ]}
      />

      <div className="grid gap-5 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @3xl/main:items-start">
        <Panel title="Events here" hint={rows.length ? `${rows.length} in window` : undefined} bodyClassName="px-4 pb-4 pt-3">
          <VenueEventsTable rows={rows} />
        </Panel>
        <Panel title="Ratings" hint={averageRating === null ? "all-time" : `avg ${averageRating} · all-time`}>
          {ratingTotal === 0 ? (
            <p className="text-[0.8125rem] text-muted-foreground">Nobody has rated an event here yet.</p>
          ) : averageRating === null ? (
            <p className="text-[0.8125rem] text-muted-foreground">Not enough ratings yet.</p>
          ) : (
            <RatingBars counts={ratings} />
          )}
        </Panel>
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
        venue={record}
        isAdmin={isAdmin}
      />
    </div>
  )
}

/**
 * The venue's own header (`OWNED_HEADERS`), for both views of this page. The
 * owner's view carries the date range — this is one of the three routes whose
 * numbers read it (`showsRange`) — and the adding organisation's does not.
 */
function VenueHeader({
  name,
  meta,
  line,
  ranged = false,
}: {
  name: string
  meta: string
  line: string
  ranged?: boolean
}) {
  return (
    <PageHeader
      title={name}
      description={meta}
      actions={
        ranged ? (
          // useSearchParams needs a Suspense boundary.
          <Suspense fallback={<div className="h-9 w-[250px]" />}>
            <DateRangeControl />
          </Suspense>
        ) : undefined
      }
    >
      <p className="text-[0.8125rem] text-muted-foreground">{line}</p>
    </PageHeader>
  )
}
