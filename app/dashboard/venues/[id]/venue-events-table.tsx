"use client"

import { IconCalendar } from "@tabler/icons-react"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { formatPct, formatSince } from "@/lib/dashboard-format"

/**
 * Events at one venue.
 *
 * Split out of the page for the same reason as `attendees-table.tsx`: the page
 * is a server component and these columns carry `render`, `sortValue` and
 * `rowHref` **functions**, which cannot be serialised across the boundary into
 * `DataTable`.
 */

export interface VenueEventRow {
  id: string
  title: string
  startAt: string
  organiser: string
  going: number
  attended: number
  fillPct: number | null
  status: string
}

const columns: Column<VenueEventRow>[] = [
  { key: "title", label: "Event", sortType: "string", primary: true },
  {
    key: "startAt",
    label: "Date",
    align: "right",
    sortType: "date",
    sortValue: (r) => new Date(r.startAt),
    render: (r) => formatSince(r.startAt),
  },
  { key: "organiser", label: "Organiser", sortType: "string", secondary: true },
  { key: "going", label: "Going", align: "right", sortType: "number" },
  { key: "attended", label: "Attended", align: "right", sortType: "number" },
  {
    key: "fillPct",
    label: "Fill",
    align: "right",
    sortType: "number",
    render: (r) => formatPct(r.fillPct),
  },
  {
    key: "status",
    label: "",
    sortable: false,
    render: (r) => (
      <Badge variant={r.status === "published" ? "default" : "secondary"}>{r.status}</Badge>
    ),
  },
]

export function VenueEventsTable({ rows }: { rows: VenueEventRow[] }) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      sortable
      defaultSort={{ key: "startAt", dir: "desc" }}
      search
      searchPlaceholder="Search events at this venue…"
      pagination
      rowHref={(r) => `/dashboard/events/${r.id}`}
      emptyState={
        <EmptyState
          icon={<IconCalendar />}
          title="No events in this window"
          description="Events linked to this venue appear here. Widen the date range in the top bar to see further back."
        />
      }
    />
  )
}
