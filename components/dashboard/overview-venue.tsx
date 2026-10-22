"use client"

// Client because it hands DataTable `render`/`sortValue` functions, and
// DataTable is a client component. A server component cannot serialise a
// function across that boundary — it throws at render, not at build. These
// take their data as a prop and touch nothing server-only, so the directive
// is the whole fix.
import Link from "next/link"
import { IconAlertTriangle, IconBuildingStore } from "@tabler/icons-react"

import { BuildingOccupancyPanel } from "@/components/dashboard/building-occupancy-panel"
import { UtilHeatmap } from "@/components/dashboard/charts"
import { DataTable, type Column } from "@/components/dashboard/data-table"
import { KpiStrip, Panel } from "@/components/dashboard/kit"
import { EmptyState, RatingBars } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import type { VenueOverview, VenueRow } from "@/lib/dashboard-types"
import { formatDay, formatNumber, formatPct } from "@/lib/dashboard-format"

/**
 * Venue owner overview, in the kit's order (`venue-sponsor.jsx`
 * VenueOverview): who is in the building now, each venue on its own row, when
 * the rooms are busy, the ratings, then three tiles.
 *
 * Per venue, always. Never a blended number: someone operating three rooms
 * saw one average across all of them when this role was handed the organiser
 * dashboard, and a bad room drags a mean without ever being identifiable.
 *
 * "In the building" leads only while a room runs (the screen's memorable
 * detail); with the buildings dark it is not drawn at all.
 */
export function OverviewVenue({ data }: { data: VenueOverview }) {
  const columns: Column<VenueRow & { id: string; venueId: string | null }>[] = [
    {
      key: "name",
      label: "Venue",
      primary: true,
      // A free-text name bucket has no record to open.
      render: (r) =>
        r.venueId ? (
          <Link href={`/dashboard/venues/${r.venueId}`} className="underline-offset-4 hover:underline">
            {r.name}
          </Link>
        ) : (
          r.name
        ),
    },
    { key: "nightsPerWeek", label: "Nights/wk", align: "right" },
    { key: "eventsInWindow", label: "Events (8w)", align: "right", secondary: true },
    {
      key: "averageRating",
      label: "Rating",
      align: "right",
      render: (r) =>
        r.averageRating === null ? (
          "—"
        ) : (
          <span className={r.averageRating < 3.5 ? "font-bold text-destructive" : undefined}>{r.averageRating}</span>
        ),
    },
    {
      key: "nextBooking",
      label: "Next booking",
      align: "right",
      render: (r) => (r.nextBooking ? formatDay(r.nextBooking.startAt) : "—"),
      secondary: true,
    },
    {
      key: "note",
      label: "",
      // Colour only for the one that needs attention. "performing" used to be a
      // brand-orange badge -- the primary colour on a status word.
      render: (r) =>
        r.tone === "destructive" ? (
          <Badge variant="destructive">{r.note}</Badge>
        ) : (
          <span className="text-[0.8125rem] text-muted-foreground">{r.note}</span>
        ),
    },
  ]

  const worstRoom = data.venues.find(
    (venue) => venue.ratings[0] + venue.ratings[1] > venue.ratings[3] + venue.ratings[4]
  )
  const focusVenue = data.venues[0]
  const hasRatings = Boolean(focusVenue && focusVenue.ratings.some((n) => n > 0))

  return (
    <div className="flex flex-col gap-5">
      {data.buildings.map((b) => (
        <BuildingOccupancyPanel
          key={b.venueId}
          occupancy={b.occupancy}
          // Named only when it could be one of several.
          venueName={data.venues.length > 1 ? b.venueName : undefined}
        />
      ))}

      <Panel
        title="Your venues"
        hint={data.venues.length ? `${data.venues.length} venue${data.venues.length === 1 ? "" : "s"} · last 8 weeks` : undefined}
        bodyClassName="px-4 pb-4 pt-3"
      >
        <DataTable
          columns={columns}
          rows={data.venues.map((venue) => ({ ...venue, id: venue.id ?? `name:${venue.name}`, venueId: venue.id }))}
          emptyState={
            <EmptyState
              icon={<IconBuildingStore />}
              title="No venues yet"
              description="Add your venue, or claim it if it is already listed. Each one gets its own row — utilisation, ratings and bookings are never blended."
            />
          }
        />
      </Panel>

      {worstRoom ? (
        <p className="flex items-start gap-2 text-[0.8125rem] text-destructive">
          <IconAlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          Ratings skew low at {worstRoom.name} across different events — likely a facilities problem rather than an
          event problem.
        </p>
      ) : null}

      {/* The ratings panel appears once there is a rating to show; before that the heatmap has the width. */}
      <div
        className={
          hasRatings
            ? "grid gap-5 @3xl/main:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] @3xl/main:items-start"
            : "grid gap-5"
        }
      >
        <Panel>
          <UtilHeatmap counts={data.utilisation} empty={data.utilisation.every((day) => day.every((n) => n === 0))} />
        </Panel>
        {hasRatings ? (
          <Panel
            title="Ratings"
            hint={[focusVenue!.name, focusVenue!.averageRating !== null ? `avg ${focusVenue!.averageRating}` : null]
              .filter(Boolean)
              .join(" · ")}
          >
            <RatingBars counts={focusVenue!.ratings} />
          </Panel>
        ) : null}
      </div>

      <KpiStrip
        items={[
          {
            label: "Peak window",
            value: data.peakWindow,
            hint: data.peakWindow ? "busiest slot, last 8 weeks" : "needs event history",
          },
          {
            label: "Turn-up rate",
            value: data.turnUpRatePct === null ? null : formatPct(data.turnUpRatePct),
            // Percentage points, so the badge carries "pts" rather than "%" —
            // "+6%" on a rate already in percent reads as 6% of the rate.
            delta: data.turnUpDelta ?? undefined,
            deltaSuffix: "pts",
            hint: data.turnUpDelta === null ? "across your venues" : "vs previous 90 days",
          },
          { label: "Events next 14d", value: formatNumber(data.eventsNext14d), href: "/dashboard/events" },
        ]}
      />
    </div>
  )
}
