"use client"

import { IconUsers } from "@tabler/icons-react"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState, MetricTile } from "@/components/dashboard/primitives"
import type { EventAttendeeRow, EventAttendees } from "@/lib/attendee-roster"
import { MIN_CELL } from "@/lib/disclosure"
import { eventClock } from "@/lib/event-phase"

const RSVP_LABEL = { going: "Going", maybe: "Maybe" } as const

/**
 * One event's attendees, by label (SCRUM-499).
 *
 * The rows arrive in door order, earliest arrival first, and with no default
 * sort the table keeps it. Read top to bottom, it is the door log. Committed
 * RSVPs who never came sit at the bottom, where they read "No-show" once the
 * event is over.
 *
 * Labels only (owner ruling R1, SCRUM-383 b). The design kit's version of this
 * tab has names, avatars and a per-person "Now: In the room" column. Each
 * person here is the label the Check-ins export and the organisation's
 * Attendees list use, so one row can be followed across all three.
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
  // The event's clock, not the browser's (SCRUM-421). The time alone on the
  // night, plus the day once an arrival falls on another calendar day: day two
  // of a conference, or after midnight.
  const clock = eventClock(timezone)
  const start = new Date(startAt)
  const arrival = (iso: string) => {
    const at = new Date(iso)
    return clock.daysUntil(at, start) === 0 ? clock.time(at) : `${clock.day(at)}, ${clock.time(at)}`
  }

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
      // Hidden on a phone, where the label and the arrival are the door log.
      secondary: true,
      // A row with no committed RSVP is somebody who came anyway.
      render: (r) => (r.rsvp ? RSVP_LABEL[r.rsvp] : <span className="text-muted-foreground">Walk-in</span>),
    },
    {
      key: "arrivedAt",
      label: "Checked in",
      align: "right",
      sortType: "date",
      sortValue: (r) => (r.arrivedAt ? new Date(r.arrivedAt) : null),
      render: (r) =>
        r.arrivedAt ? (
          <span className="tabular-nums">{arrival(r.arrivedAt)}</span>
        ) : r.status === "came" ? (
          "Checked in"
        ) : r.status === "no_show" ? (
          <span className="font-bold text-warning">No-show</span>
        ) : (
          <span className="text-faint-foreground" aria-label="Not yet">
            —
          </span>
        ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={roster.rows}
      sortable
      search
      searchPlaceholder="Search labels…"
      pagination
      emptyState={
        <EmptyState
          icon={<IconUsers />}
          title="Nobody yet"
          description="People who RSVP or check in appear here in the order they arrive, each as a label rather than their name."
        />
      }
      footer={
        <span>
          {roster.came} came · {roster.walkIns} walked in · {roster.noShows} no-shows · each person is a label,
          never a name, and the same label as the Check-ins export
        </span>
      }
    />
  )
}

/**
 * The same tab for a venue owner operating an event in their building: how
 * many came, never who (SCRUM-501). Held back under the floor, and the tab says
 * so rather than showing a blank.
 */
export function EventAttendeesCount({ came }: { came: number | null }) {
  return (
    <section className="flex flex-col gap-2 rounded-panel border border-border bg-card p-5">
      <MetricTile
        label="Came"
        value={came}
        hint={came === null ? `fewer than ${MIN_CELL}, held back` : "people checked in"}
        className="px-0 py-0"
      />
      <p className="max-w-[70ch] text-[0.8125rem] text-muted-foreground">
        {came === null
          ? `A venue sees how many came, never who, and under ${MIN_CELL} a count can point at a person.`
          : "A venue sees how many came, never who. The organiser has the list."}
      </p>
    </section>
  )
}
