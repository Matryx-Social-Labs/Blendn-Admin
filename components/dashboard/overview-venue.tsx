"use client"

// Client because it hands DataTable `render`/`sortValue` functions, and
// DataTable is a client component. A server component cannot serialise a
// function across that boundary — it throws at render, not at build. These
// take their data as a prop and touch nothing server-only, so the directive
// is the whole fix.
import { IconAlertTriangle, IconBuildingStore } from "@tabler/icons-react"

import { UtilHeatmap } from "@/components/dashboard/charts"
import { DataTable, type Column } from "@/components/dashboard/data-table"
import {
  EmptyState,
  MetricTile,
  RatingBars,
  SectionTitle,
} from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import type { VenueOverview, VenueRow } from "@/lib/dashboard-types"
import { formatDay, formatNumber, formatPct } from "@/lib/dashboard-format"

/**
 * Venue owner overview — per venue, always. Never a blended number.
 *
 * The previous version handed this role the organiser dashboard with two
 * strings swapped, so someone operating three rooms saw one average across all
 * of them. An average is exactly the wrong shape here: a bad room drags the
 * mean without ever being identifiable.
 */
export function OverviewVenue({ data }: { data: VenueOverview }) {
  const columns: Column<VenueRow & { id: string }>[] = [
    { key: "name", label: "Venue" },
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
          <span
            className={
              r.averageRating < 3.5 ? "font-bold text-destructive" : undefined
            }
          >
            {r.averageRating}
          </span>
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionTitle hint={data.venues.length ? `${data.venues.length} venues` : undefined}>
          Your venues
        </SectionTitle>
        <DataTable
          columns={columns}
          rows={data.venues.map((venue) => ({ ...venue, id: venue.name }))}
          emptyState={
            <EmptyState
              icon={<IconBuildingStore />}
              title="No venues yet"
              description="Each venue you host at gets its own row — utilisation, ratings and bookings are never blended. Venues are read from the venue name on your events."
            />
          }
        />
      </div>

      {worstRoom ? (
        <p className="flex items-start gap-2 text-[0.8125rem] text-destructive">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
          Ratings skew low at {worstRoom.name} across different events — likely a facilities
          problem rather than an event problem.
        </p>
      ) : null}

      {/* The ratings panel appears once there is a rating to show; before that the heatmap has the width. */}
      <div className={hasRatings ? "grid gap-6 @3xl/main:grid-cols-[3fr_2fr]" : "grid gap-6"}>
        <UtilHeatmap counts={data.utilisation} empty={data.venues.length === 0} />
        {hasRatings ? (
        <div className="flex flex-col gap-3">
          <SectionTitle
            hint={
              focusVenue
                ? [focusVenue.name, focusVenue.averageRating !== null ? `avg ${focusVenue.averageRating}` : null]
                    .filter(Boolean)
                    .join(" · ")
                : undefined
            }
          >
            Ratings
          </SectionTitle>
          <RatingBars counts={focusVenue!.ratings} />
        </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        <MetricTile
          label="Peak window"
          value={data.peakWindow}
          hint={data.peakWindow ? "busiest slot, last 8 weeks" : "needs event history"}
        />
        <MetricTile
          label="Turn-up rate"
          value={data.turnUpRatePct === null ? null : formatPct(data.turnUpRatePct)}
          // Percentage points, so the badge carries "pts" rather than "%" —
          // "+6%" on a rate already in percent reads as 6% of the rate.
          delta={data.turnUpDelta ?? undefined}
          deltaSuffix="pts"
          hint={data.turnUpDelta === null ? "across your venues" : "vs previous 90 days"}
        />
        <MetricTile
          label="Events next 14d"
          value={formatNumber(data.eventsNext14d)}
          href="/dashboard/events"
        />
      </div>
    </div>
  )
}
