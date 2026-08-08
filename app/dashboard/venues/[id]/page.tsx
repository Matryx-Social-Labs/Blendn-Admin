import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { IconMapPin } from "@tabler/icons-react"

import { BuildingOccupancyPanel } from "@/components/dashboard/building-occupancy-panel"
import { EmptyState, MetricTile, RatingBars, SectionTitle } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { VenueEventsTable, type VenueEventRow } from "./venue-events-table"
import { getAuth } from "@/lib/auth"
import { getBuildingOccupancy } from "@/lib/building-occupancy"
import { db } from "@/lib/db"
import { formatNumber, formatPct } from "@/lib/dashboard-format"
import { resolveRange } from "@/lib/date-range"

export const dynamic = "force-dynamic"

const ATTENDED = ["checked_in", "checked_out"] as const

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

  const venue = await db.venues.findUnique({
    where: { id, deleted_at: null },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      capacity: true,
      status: true,
      claimed_at: true,
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
            check_ins: { where: { status: { in: [...ATTENDED] } } },
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

  const rows: VenueEventRow[] = events.map((e) => ({
    id: e.id,
    title: e.title,
    startAt: e.start_time.toISOString(),
    status: e.status,
    // The organising company, falling back to whoever created it — an event
    // predating organisations has no org.
    organiser: e.organizer_org?.display_name ?? e.organizer?.name ?? "—",
    going: e._count.rsvps,
    attended: e._count.check_ins,
    fillPct: e.max_capacity ? Math.round((e._count.rsvps / e.max_capacity) * 100) : null,
  }))

  const totalAttended = rows.reduce((sum, r) => sum + r.attended, 0)
  const totalGoing = rows.reduce((sum, r) => sum + r.going, 0)
  // Capped at 100: walk-ins check in without an RSVP, so attendance can exceed
  // commitments and a raw ratio would read over 100%.
  const turnUp = totalGoing === 0 ? null : Math.min(100, (totalAttended / totalGoing) * 100)

  const repeatOrganisers = new Map<string, number>()
  for (const r of rows) repeatOrganisers.set(r.organiser, (repeatOrganisers.get(r.organiser) ?? 0) + 1)
  const returning = [...repeatOrganisers.values()].filter((n) => n > 1).length


  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[length:var(--text-h2)] font-bold">{venue.name}</h2>
          <p className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
            <IconMapPin className="size-3.5" />
            {[venue.address, venue.city].filter(Boolean).join(", ") || "No address recorded"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={venue.status === "active" ? "default" : "secondary"}>{venue.status}</Badge>
          {venue.claimed_at ? (
            isAdmin && venue.owner_org ? (
              <Badge variant="outline">{venue.owner_org.display_name}</Badge>
            ) : null
          ) : (
            // Only an admin ever sees an unclaimed venue, so this is a prompt
            // to act rather than a status nobody can change.
            <Badge variant="outline">Unclaimed</Badge>
          )}
        </div>
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
          label="Capacity"
          value={venue.capacity ?? null}
          hint={venue.capacity ? "declared" : "none declared"}
        />
        <MetricTile
          label="Returning organisers"
          value={returning}
          hint={returning === 0 ? "nobody has come back yet" : "booked here more than once"}
        />
      </div>

      <div className="grid gap-6 @3xl/main:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-3">
          <SectionTitle hint={rows.length ? `${rows.length} in window` : undefined}>
            Events here
          </SectionTitle>
          <VenueEventsTable rows={rows} />
        </div>
        <div className="flex flex-col gap-3">
          <SectionTitle hint={ratingTotal ? `avg ${averageRating}` : undefined}>Ratings</SectionTitle>
          {ratingTotal === 0 ? (
            <EmptyState
              compact
              description="No ratings for events at this venue yet. Ratings are all-time, not limited to the date range."
            />
          ) : (
            <RatingBars counts={ratings} />
          )}
        </div>
      </div>

      <p className="text-[0.75rem] text-faint-foreground">
        <Link href="/dashboard/venues" className="hover:text-foreground hover:underline">
          ← All venues
        </Link>
      </p>
    </div>
  )
}
