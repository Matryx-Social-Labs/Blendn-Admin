"use client"

import { IconUsers } from "@tabler/icons-react"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState, MetricTile } from "@/components/dashboard/primitives"
import type { EventAttendeeRow, EventAttendees } from "@/lib/attendee-roster"
import { MIN_CELL } from "@/lib/disclosure"
import { eventClock } from "@/lib/event-phase"

const RSVP_LABEL = { going: "Going", maybe: "Maybe" } as const

const QUARTER_HOUR_MS = 15 * 60_000

/**
 * One event's attendees, by label (SCRUM-499).
 *
 * Labels only (owner ruling R1, SCRUM-383 b). The design kit's version of this
 * tab has names, avatars and a per-person "Now: In the room" column. Each
 * person here is the label the Check-ins export and the organisation's
 * Attendees list use, so one row can be followed across all three.
 *
 * Arrivals are a quarter-hour window, and the rows are in label order. The
 * room announces each check-in under a room pseudonym; an arrival to the
 * minute, or the door's order, would let a host match that pseudonym to this
 * label. Below `MIN_CELL` arrivals the server sends no arrival at all.
 *
 * A client file only because the columns carry functions, which cannot cross
 * from the server page. See `app/dashboard/attendees/attendees-table.tsx`.
 */
export function EventAttendeesTable({
  roster,
  timezone,
  startAt,
}: {
  roster: Extract<EventAttendees, { view: "labels" }>
  timezone: string
  startAt: string
}) {
  // The event's clock, not the browser's (SCRUM-421). The window alone on the
  // night, plus the day once it falls on another calendar day: day two of a
  // conference, or after midnight.
  const clock = eventClock(timezone)
  const start = new Date(startAt)
  const arrival = (iso: string) => {
    const from = new Date(iso)
    const quarter = `${clock.time(from)}–${clock.time(new Date(from.getTime() + QUARTER_HOUR_MS))}`
    return clock.daysUntil(from, start) === 0 ? quarter : `${clock.day(from)}, ${quarter}`
  }
  const heldBack = roster.walkIns === null

  const columns: Column<EventAttendeeRow>[] = [
    {
      key: "id",
      label: "Attendee",
      sortType: "string",
      primary: true,
      render: (r) => <span className="whitespace-nowrap font-mono text-[0.78125rem]">{r.id}</span>,
    },
    {
      key: "rsvp",
      label: "RSVP",
      sortType: "string",
      // Hidden on a phone, where the label and the arrival are what matter.
      secondary: true,
      // A row with no committed RSVP is somebody who came anyway.
      render: (r) => (r.rsvp ? RSVP_LABEL[r.rsvp] : <span className="text-muted-foreground">Walk-in</span>),
    },
    {
      key: "arrivedAt",
      label: "Arrival",
      align: "right",
      sortType: "date",
      sortValue: (r) => (r.arrivedAt ? new Date(r.arrivedAt) : null),
      render: (r) =>
        r.status === "held_back" ? (
          <span className="text-faint-foreground">held back</span>
        ) : r.arrivedAt ? (
          <span className="whitespace-nowrap tabular-nums">{arrival(r.arrivedAt)}</span>
        ) : r.status === "came" ? (
          "Checked in"
        ) : r.status === "no_show" ? (
          <span className="font-bold text-warning">No-show</span>
        ) : (
          <>
            <span aria-hidden className="text-faint-foreground">
              —
            </span>
            <span className="sr-only">Not yet</span>
          </>
        ),
    },
  ]

  return (
    <DataTable
      label="Attendees of this event"
      columns={columns}
      rows={roster.rows}
      sortable
      search
      searchPlaceholder="Search attendees…"
      pagination
      emptyState={
        <EmptyState
          icon={<IconUsers />}
          title="Nobody yet"
          description="People who RSVP or check in appear here, each as a label rather than their name."
        />
      }
      footer={
        <span>
          {heldBack
            ? `${roster.came} came: under ${MIN_CELL}, who came and when is held back`
            : `${roster.came} came · ${roster.walkIns} walked in · ${roster.noShows} no-shows · arrivals to the quarter hour`}
          {" · "}each person is a label, never a name, and the same label as the Check-ins export
        </span>
      }
    />
  )
}

/**
 * The same tab for a venue owner operating an event in their building: how
 * many came, never who. Before the doors there is nothing to count; zero is
 * shown, because it identifies nobody; anything held back says so rather than
 * showing a blank.
 */
export function EventAttendeesCount({ started, came }: { started: boolean; came: number | null }) {
  return (
    <section className="flex flex-col gap-2 rounded-panel border border-border bg-card p-5">
      <MetricTile
        label="Came"
        value={started ? came : null}
        hint={!started ? "doors not open yet" : came === null ? "held back" : "people checked in"}
        className="px-0 py-0"
      />
      <p className="max-w-[70ch] text-[0.8125rem] text-muted-foreground">
        {started && came === null
          ? "A venue sees how many came, never who, and this count could point at somebody, so it is held back."
          : "A venue sees how many came, never who. The organiser has the list."}
      </p>
    </section>
  )
}
