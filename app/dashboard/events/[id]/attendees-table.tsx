"use client"

import { IconUsers } from "@tabler/icons-react"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState, MetricTile } from "@/components/dashboard/primitives"
import type { EventAttendeeRow, EventAttendees } from "@/lib/attendee-roster"
import { liveCountLabel, MIN_CELL, type LiveCountBucket } from "@/lib/disclosure"

const RSVP_LABEL = { going: "Going", maybe: "Maybe" } as const

/**
 * One event's attendees, by label (SCRUM-499).
 *
 * Labels only (owner ruling R1, SCRUM-383 b). The design kit's version of this
 * tab has names, avatars and a per-person "Now: In the room" column. Each
 * person here is the label the Attendees export and the organisation's
 * Attendees list use, so one row can be followed across all three.
 *
 * Whether each came, never when, and the rows in label order (SCRUM-887). The
 * room announces each check-in under a room pseudonym; an arrival time, or the
 * door's order, would let a host match that pseudonym to this label. Below
 * `MIN_CELL` arrivals the server says nothing about who came.
 *
 * A client file only because the columns carry functions, which cannot cross
 * from the server page. See `app/dashboard/attendees/attendees-table.tsx`.
 */
export function EventAttendeesTable({ roster }: { roster: Extract<EventAttendees, { view: "labels" }> }) {
  const heldBack = roster.walkIns === null

  // Not settled (SCRUM-887): who came is shown once, two hours after the night, as it was then.
  if (roster.pending) {
    return (
      <EmptyState
        icon={<IconUsers />}
        title="After the night"
        description="Who came appears two hours after the night ends, each as a label, never a name. Anyone who checks in later is not added."
      />
    )
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
      // Hidden on a phone, where the label and whether they came are what matter.
      secondary: true,
      // A row with no committed RSVP is somebody who came anyway.
      render: (r) => (r.rsvp ? RSVP_LABEL[r.rsvp] : <span className="text-muted-foreground">Walk-in</span>),
    },
    {
      // Whether, never when (SCRUM-887): an arrival time lines this label up with the room's pseudonym.
      key: "status",
      label: "Status",
      align: "right",
      sortType: "string",
      render: (r) =>
        r.status === "held_back" ? (
          <span className="text-faint-foreground">held back</span>
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
            ? `${roster.came} came: under ${MIN_CELL}, who came is held back`
            : `${roster.came} came · ${roster.walkIns} walked in · ${roster.noShows} no-shows`}
          {" · "}each person is a label, never a name, and the same label as the Attendees export
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
export function EventAttendeesCount({ started, came }: { started: boolean; came: number | LiveCountBucket | null }) {
  return (
    <section className="flex flex-col gap-2 rounded-panel border border-border bg-card p-5">
      <MetricTile
        label="Came"
        value={started && came !== null ? liveCountLabel(came) : null}
        hint={
          !started
            ? "doors not open yet"
            : came === null
              ? "held back"
              : // A range while the night runs (SCRUM-516).
                typeof came === "string"
                ? "so far — a range until it ends"
                : "people checked in"
        }
        className="px-0 py-0"
      />
      <p className="max-w-[70ch] text-[0.8125rem] text-muted-foreground">
        {started && came === null
          ? "A venue sees how many came, never who, and this count could point at somebody, so it is held back."
          : "A venue sees how many came, never who. The organizer has the list."}
      </p>
    </section>
  )
}
