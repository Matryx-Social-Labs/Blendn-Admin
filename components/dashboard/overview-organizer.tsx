"use client"

// Client because it hands DataTable `render`/`sortValue` functions, and
// DataTable is a client component. A server component cannot serialise a
// function across that boundary — it throws at render, not at build. These
// take their data as a prop and touch nothing server-only, so the directive
// is the whole fix.
import Link from "next/link"
import {
  IconCalendarPlus,
  IconPlus,
} from "@tabler/icons-react"

import { PacingChart } from "@/components/dashboard/charts"
import { DataTable, type Column } from "@/components/dashboard/data-table"
import {
  EmptyState,
  HeroMetric,
  MetricTile,
  RatingBars,
  SectionTitle,
} from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { EventRow, OrganizerOverview } from "@/lib/dashboard-types"
import { formatDay, formatNumber, formatPct, statusTone } from "@/lib/dashboard-format"

/**
 * Organiser overview — "how is my next event pacing" answered first, in the
 * largest type on the page, before anything trailing.
 *
 * The previous version led with four 30-day lookback cards, so the one question
 * an organiser actually arrives with was not on the screen at all.
 */
export function OverviewOrganizer({ data }: { data: OrganizerOverview }) {
  const { nextEvent } = data

  const columns: Column<EventRow>[] = [
    { key: "name", label: "Event" },
    { key: "startAt", label: "Date", render: (r) => formatDay(r.startAt) },
    {
      key: "status",
      label: "Status",
      // Published is the norm and unmarked. The old version put a brand-orange
      // badge on every published row -- fourteen of them, shouting the default.
      render: (r) =>
        r.status === "published" ? null : (
          <Badge variant={statusTone(r.status)}>{r.status.replace(/_/g, " ")}</Badge>
        ),
    },
    { key: "going", label: "Going", align: "right", secondary: true },
    {
      key: "fillPct",
      label: "Fill",
      align: "right",
      render: (r) => formatPct(r.fillPct),
      secondary: true,
    },
    {
      key: "turnUpPct",
      label: "Turn-up",
      align: "right",
      render: (r) => formatPct(r.turnUpPct),
      secondary: true,
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      {nextEvent ? (
        <HeroMetric
          // The venue only when the title does not already say it — "Sunset
          // Sessions at The Humming Tree · The Humming Tree" read twice.
          eyebrow={`${formatDay(nextEvent.startAt)} · ${nextEvent.title}${
            nextEvent.venue !== "Venue TBD" && !nextEvent.title.includes(nextEvent.venue)
              ? ` · ${nextEvent.venue}`
              : ""
          }`}
          value={nextEvent.fillPct === null ? formatNumber(nextEvent.going) : formatPct(nextEvent.fillPct)}
          unit={
            nextEvent.fillPct === null
              ? `going · ${daysToGo(nextEvent.daysOut)}`
              : `filled · ${daysToGo(nextEvent.daysOut)}`
          }
          progress={nextEvent.fillPct}
          // The value above already says going (or fill, with going as the
          // "N of capacity" here). Never the same number twice on one card.
          description={[
            ...(nextEvent.capacity
              ? [`${formatNumber(nextEvent.going)} of ${formatNumber(nextEvent.capacity)} going`]
              : []),
            `${formatNumber(nextEvent.maybe)} maybe`,
            `${formatNumber(nextEvent.favourites)} saved`,
          ]
            .join(" · ")
            .concat(nextEvent.pacingNote ? `. ${nextEvent.pacingNote}` : "")}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href={`/dashboard/events/${nextEvent.id}`}>Open event</Link>
            </Button>
          }
        />
      ) : (
        <HeroMetric
          eyebrow="Next event"
          value="—"
          description="No upcoming event. Publish one and RSVPs, saves and the pacing curve appear here."
          action={
            <Button asChild size="sm">
              <Link href="/dashboard/events/new">
                <IconPlus className="size-4" />
                Create event
              </Link>
            </Button>
          }
        />
      )}

      {/*
        The chart takes the width until there are ratings to show beside it.
        An organiser with no ratings yet used to get an empty dashed box for
        40% of the top row, and the tile below already says "no ratings yet".
      */}
      <div className={data.ratingCount ? "grid gap-6 @3xl/main:grid-cols-[3fr_2fr]" : "grid gap-6"}>
        <PacingChart
          points={data.pacing}
          capacity={data.pacingCapacity}
          benchmark={data.benchmark}
          windowDays={data.pacing.length ? data.pacing[0].daysOut : 21}
          empty={!nextEvent || data.pacing.every((p) => p.cumulative === 0)}
        />
        {data.ratingCount ? (
          <div className="flex flex-col gap-3">
            <SectionTitle hint={`avg ${data.averageRating}`}>Ratings</SectionTitle>
            <RatingBars counts={data.ratings} />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        <MetricTile
          label="No-show rate"
          value={data.noShowRatePct === null ? null : formatPct(data.noShowRatePct)}
          delta={data.noShowDelta ?? undefined}
          deltaInvert
          hint={data.noShowRatePct === null ? "needs a past event" : "last 30 days"}
          href="/dashboard/attendees"
        />
        <MetricTile
          label="Repeat attendees"
          value={data.repeatAttendees}
          hint="came back for a 2nd event"
          href="/dashboard/attendees"
        />
        <MetricTile
          label="Avg rating"
          value={data.averageRating}
          hint={data.ratingCount ? `${formatNumber(data.ratingCount)} ratings` : "no ratings yet"}
        />
        <MetricTile
          label="Chat today"
          value={data.chatToday}
          hint="messages"
          href="/dashboard/chatrooms"
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>Your events</SectionTitle>
        <DataTable
          columns={columns}
          rows={data.events}
          rowHref={(row) => `/dashboard/events/${row.id}`}
          emptyState={
            <EmptyState
              icon={<IconCalendarPlus />}
              title="No events yet"
              description="Create your first event — pacing, attendance and ratings all start here."
              action={
                <Button asChild size="sm">
                  <Link href="/dashboard/events/new">Create event</Link>
                </Button>
              }
            />
          }
          footer={
            <span>
              {formatNumber(data.events.length)} events · published is unmarked · fill is — when no
              capacity is set
            </span>
          }
        />
      </div>
    </div>
  )
}

const daysToGo = (days: number) =>
  days === 0 ? "today" : days === 1 ? "1 day to go" : `${days} days to go`
