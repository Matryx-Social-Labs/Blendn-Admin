"use client"

import { IconUsers } from "@tabler/icons-react"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import { formatSince } from "@/lib/dashboard-format"

/**
 * The attendee table, split out of the page.
 *
 * The page is a server component — it reads the session and the database — and
 * the columns below carry `render` and `sortValue` **functions**. A function
 * cannot cross the server/client boundary, and `DataTable` is a client
 * component, so defining these columns in the page threw at render time.
 *
 * The page keeps the data fetching; this file keeps everything that is a
 * function. `AttendeeRow` is plain data, so it serialises fine.
 */

export interface AttendeeRow {
  id: string
  name: string
  attended: number
  rsvps: number
  noShows: number
  lastAttendedAt: string | null
  repeat: boolean
}

const columns: Column<AttendeeRow>[] = [
  { key: "name", label: "Person", sortType: "string", primary: true },
  {
    key: "attended",
    label: "Attended",
    align: "right",
    sortType: "number",
    // Bold from the second event on. That is the repeat signal; it used to be
    // a brand-orange "repeat" chip in its own column, and orange is for the
    // one primary action on a screen.
    render: (r) => <span className={r.repeat ? "font-bold" : undefined}>{r.attended}</span>,
  },
  { key: "rsvps", label: "RSVPs", align: "right", secondary: true, sortType: "number" },
  {
    key: "noShows",
    label: "No-shows",
    align: "right",
    sortType: "number",
    render: (r) => <span className={r.noShows > 1 ? "font-bold text-warning" : undefined}>{r.noShows}</span>,
  },
  {
    key: "lastAttendedAt",
    label: "Last attended",
    align: "right",
    // The cell renders "3d ago", so the sort has to run on the timestamp —
    // sorting the rendered string puts "3d" next to "30d" and before "1d".
    // Nulls (never attended) sort last in both directions, which is what you
    // want when looking for the most recent.
    sortType: "date",
    sortValue: (r) => (r.lastAttendedAt ? new Date(r.lastAttendedAt) : null),
    render: (r) => formatSince(r.lastAttendedAt),
    secondary: true,
  },
]

export function AttendeesTable({ rows }: { rows: AttendeeRow[] }) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      sortable
      // Most-attended first is the meaningful default; the third click on any
      // header returns to it.
      defaultSort={{ key: "attended", dir: "desc" }}
      search
      searchPlaceholder="Search attendees…"
      pagination
      columnMenu
      emptyState={
        <EmptyState
          icon={<IconUsers />}
          title="No attendees yet"
          description="People who RSVP and check in to your events build this list — repeat attendance is the loyalty signal."
        />
      }
      footer={
        <span>
          attended = GPS check-in · committed RSVPs without a check-in count as no-shows
        </span>
      }
    />
  )
}
