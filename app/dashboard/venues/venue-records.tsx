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
export function VenueRecords({
  venues,
  total,
  q = "",
}: {
  venues: VenueRecordRow[]
  total: number
  /** The server-side search, so the count line can say what it counts. */
  q?: string
}) {
  const unclaimed = venues.filter((venue) => venue.owner === null).length

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
    {
      key: "status",
      label: "Status",
      sortType: "string",
      secondary: true,
      // Venues gained a lifecycle in #319 and this index never showed it, so an
      // archived venue was indistinguishable from a live one on the only screen
      // that lists them all.
      render: (row) =>
        row.status === "active" ? (
          <span className="text-muted-foreground">active</span>
        ) : (
          <Badge variant="outline" className="text-[0.6875rem]">
            {row.status}
          </Badge>
        ),
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
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] text-muted-foreground">
        {/*
          The cap, stated. This screen rendered every venue in the database with
          no search and no pagination — 395 rows and a 15,812px document on the
          local seed alone. A list silently truncated at 200 would be the same
          failure quieter: an operator concludes a venue is missing.
        */}
        {venues.length < total ? (
          <>
            Showing <span className="tabular-nums">{venues.length}</span> of{" "}
            <span className="tabular-nums">{total}</span> venues{q ? ` matching “${q}”` : ""},
            unclaimed first
          </>
        ) : (
          <>
            <b className="font-bold text-foreground tabular-nums">{total}</b> venue
            {total === 1 ? "" : "s"}
            {q ? ` matching “${q}”` : ""}
            {unclaimed > 0 ? (
              <>
                {" · "}
                <span className="tabular-nums">{unclaimed}</span> unclaimed
              </>
            ) : null}
          </>
        )}
      </p>
      <DataTable
      columns={columns}
      rows={venues}
      sortable
      // A GET form, not the table's own filter: this list is a page of the
      // whole set, and a search over the page found nothing past row 200 —
      // silently, with the box still saying "Search venues…".
      search={{ name: "q", defaultValue: q }}
      searchPlaceholder="Search venues…"
      pagination
      defaultPageSize={20}
      filters={[
        {
          // Keyed on the derived `ownership`, not on `owner` — see
          // `VenueRecordRow`. A filter on `owner` would have matched nothing.
          key: "ownership",
          label: "Ownership",
          options: [
            { value: "unclaimed", label: "Unclaimed" },
            { value: "claimed", label: "Claimed" },
          ],
        },
      ]}
      rowHref={(row) => `/dashboard/venues/${row.id}`}
      emptyState={
        <EmptyState
          icon={<IconBuildingStore />}
          title="No venues yet"
          description="Venues appear as owners add them, or as we curate them. Unclaimed ones are the queue — they are places nobody has taken over yet."
        />
      }
      />
    </div>
  )
}
