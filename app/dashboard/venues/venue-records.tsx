"use client"

import Link from "next/link"
import { IconBuildingStore, IconPlus } from "@tabler/icons-react"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { StatLine } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import type { VenueRecordRow } from "@/lib/dashboard-types"

/**
 * A claimed venue somebody else has filed a claim on: a transfer waiting on a
 * person (the claims queue calls it a dispute). Derived here, from the two
 * facts the row already carries, rather than a second query.
 */
const disputed = (row: VenueRecordRow) => row.owner !== null && row.pendingClaims > 0

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
  const inDispute = venues.filter(disputed).length

  const columns: Column<VenueRecordRow>[] = [
    {
      key: "name",
      label: "Venue",
      sortType: "string",
      primary: true,
      // The city under the name, as the kit draws it; the server search still
      // matches on either.
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{row.name}</span>
          {row.city ? <span className="text-[0.75rem] text-muted-foreground">{row.city}</span> : null}
        </span>
      ),
    },
    {
      key: "owner",
      label: "Owner",
      sortType: "string",
      /*
       * "Unclaimed" is the operational state this screen exists to surface, so
       * it reads as a state rather than as a blank cell — in warning, with the
       * claims waiting on it beside it (the kit's "unclaimed · 1 claim"). A
       * queue with nothing in it is not a number anybody acts on, so a venue
       * with no claim says only "unclaimed". Sorting is on the raw value, so
       * unclaimed venues group together either way.
       */
      render: (row) =>
        row.owner ?? (
          <span className="font-medium text-warning">
            unclaimed
            {row.pendingClaims > 0
              ? ` · ${row.pendingClaims} claim${row.pendingClaims === 1 ? "" : "s"}`
              : ""}
          </span>
        ),
    },
    {
      key: "status",
      label: "Status",
      sortType: "string",
      secondary: true,
      // Venues gained a lifecycle in #319 and this index never showed it, so an
      // archived venue was indistinguishable from a live one on the only screen
      // that lists them all. A word, not a chip: active is the ordinary case
      // and reads quietly; disputed is the one that wants a decision.
      render: (row) =>
        disputed(row) ? (
          <span className="font-bold text-destructive">disputed</span>
        ) : (
          <span className={row.status === "active" ? "text-faint-foreground" : "text-muted-foreground"}>
            {row.status}
          </span>
        ),
    },
    { key: "events", label: "Events", align: "right", sortType: "number" },
  ]

  return (
    <div className="flex flex-col gap-4">
      {/*
        The cap, stated. This screen rendered every venue in the database with
        no search and no pagination — 395 rows and a 15,812px document on the
        local seed alone. A list silently truncated at 200 would be the same
        failure quieter: an operator concludes a venue is missing. So the
        counts are the kit's StatLine only when they are of the whole set.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {venues.length < total ? (
          <p className="text-[0.8125rem] text-muted-foreground">
            Showing <span className="tabular-nums">{venues.length}</span> of{" "}
            <span className="tabular-nums">{total}</span> venues{q ? ` matching “${q}”` : ""},
            unclaimed first
          </p>
        ) : (
          <StatLine
            items={[
              { value: total, label: `${total === 1 ? "venue" : "venues"}${q ? ` matching “${q}”` : ""}` },
              unclaimed > 0 && { value: unclaimed, label: "unclaimed", tone: "warning" },
              inDispute > 0 && { value: inDispute, label: "disputed", tone: "destructive" },
            ]}
          />
        )}
        {/* Admin-created venues land unclaimed, which is how the directory is
            seeded before any owner is on the platform. */}
        <Button asChild variant="outline" size="sm" className="rounded-full">
          <Link href="/dashboard/venues/new">
            <IconPlus aria-hidden className="size-4" />
            Add a venue
          </Link>
        </Button>
      </div>
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
