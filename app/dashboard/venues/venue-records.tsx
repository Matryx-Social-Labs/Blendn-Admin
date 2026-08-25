"use client"

import { IconBuildingStore } from "@tabler/icons-react"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import type { VenueRecordRow } from "@/lib/dashboard-types"

/**
 * The admin venue index — records, not utilisation.
 *
 * Client because `DataTable` sorts, and because the columns hand it `render`
 * functions. Same shape as the supply table on the overview.
 */
export function VenueRecords({ venues }: { venues: VenueRecordRow[] }) {
  const columns: Column<VenueRecordRow>[] = [
    { key: "name", label: "Venue", sortType: "string", primary: true },
    { key: "city", label: "City", sortType: "string", secondary: true },
    {
      key: "owner",
      label: "Owner",
      sortType: "string",
      /*
       * "Unclaimed" is the operational state this screen exists to surface, so
       * it reads as a state rather than as a blank cell. Sorting is on the raw
       * value, so unclaimed venues group together either way.
       */
      render: (row) =>
        row.owner ?? <span className="text-muted-foreground">Unclaimed</span>,
    },
    { key: "events", label: "Events", align: "right", sortType: "number" },
    {
      key: "pendingClaims",
      label: "Claims",
      align: "right",
      sortType: "number",
      // Zero renders as nothing rather than as "0": a queue with nothing in it
      // is not a number anybody acts on, and a column of noughts buries the row
      // that does need a decision.
      render: (row) =>
        row.pendingClaims > 0 ? <Badge variant="secondary">{row.pendingClaims}</Badge> : null,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={venues}
      sortable
      rowHref={(row) => `/dashboard/venues/${row.id}`}
      emptyState={
        <EmptyState
          icon={<IconBuildingStore />}
          title="No venues yet"
          description="Venues appear as owners add them, or as we curate them. Unclaimed ones are the queue — they are places nobody has taken over yet."
        />
      }
    />
  )
}
