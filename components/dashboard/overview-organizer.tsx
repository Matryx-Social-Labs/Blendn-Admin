import Link from "next/link"
import {
  IconCalendarPlus,
  IconPlus,
  IconStar,
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
      render: (r) => <Badge variant={statusTone(r.status)}>{r.status.replace(/_/g, " ")}</Badge>,
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
          eyebrow={`${formatDay(nextEvent.startAt)} · ${nextEvent.title}${nextEvent.venue !== "Venue TBD" ? ` · ${nextEvent.venue}` : ""}`}
          value={nextEvent.fillPct === null ? formatNumber(nextEvent.going) : formatPct(nextEvent.fillPct)}
          unit={
            nextEvent.fillPct === null
              ? `going · ${nextEvent.daysOut === 0 ? "today" : `${nextEvent.daysOut} days to go`}`
              : `filled · ${nextEvent.daysOut === 0 ? "today" : `${nextEvent.daysOut} days to go`}`
          }
          progress={nextEvent.fillPct}
          description={[
            nextEvent.capacity
              ? `${formatNumber(nextEvent.going)} of ${formatNumber(nextEvent.capacity)} going`
              : `${formatNumber(nextEvent.going)} going`,
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

      <div className="grid gap-6 @3xl/main:grid-cols-[3fr_2fr]">
        <PacingChart
          points={data.pacing}
          capacity={data.pacingCapacity}
          windowDays={data.pacing.length ? data.pacing[0].daysOut : 21}
          empty={!nextEvent || data.pacing.every((p) => p.cumulative === 0)}
        />
        <div className="flex flex-col gap-3">
          <SectionTitle hint={data.ratingCount ? `avg ${data.averageRating}` : undefined}>
            Ratings
          </SectionTitle>
          {data.ratingCount === 0 ? (
            <EmptyState
              compact
              icon={<IconStar />}
              description="Ratings arrive after your first event ends — attendees rate 1–5 in the app."
            />
          ) : (
            <RatingBars counts={data.ratings} />
          )}
        </div>
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
              {formatNumber(data.events.length)} events · fill is — when no capacity is set
            </span>
          }
        />
      </div>
    </div>
  )
}
