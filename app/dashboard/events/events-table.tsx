"use client"

import { useRouter } from "next/navigation"

import { IconCalendarEvent, IconPlus } from "@tabler/icons-react"
import { toast } from "sonner"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { CurationState } from "@/lib/curation"
import { logger } from "@/lib/logger"

export interface EventRow {
  id: string
  title: string
  status: string
  startTime: string
  /** Rendered server-side — see `whenLabel` in ./page.tsx. */
  when: string
  where: string | null
  city: string | null
  host: string | null
  rsvps: number
  arrivals: number
  curation: CurationState
  checkInReady: boolean
}

/**
 * The normal state is the quiet one.
 *
 * The first pass had `published: "default"`, which is the brand primary — so
 * fifteen of seventeen rows carried a filled orange pill and `draft`, the one
 * state that needs a decision, was the grey one. That is the hierarchy exactly
 * inverted: a badge on every row is not a badge, it is a background, and it was
 * outshouting the two markers that actually mean something.
 */
const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  published: "outline",
  draft: "default",
  cancelled: "destructive",
  completed: "outline",
}

export function EventsTable({
  rows,
  total,
  canCreate,
}: {
  rows: EventRow[]
  total: number
  canCreate: boolean
}) {
  const router = useRouter()

  /**
   * Delete moved off the row and onto a selection.
   *
   * Every row carried a filled red `Delete` pill, so eleven of the loudest
   * things on the screen were the irreversible one — on a list whose job is
   * finding an event, not destroying one. It also fired `window.confirm`, which
   * says "this cannot be undone" and cannot say what goes with it.
   *
   * `DataTable`'s bulk bar already does this properly: nothing is destructive
   * until you have deliberately selected something, and the confirmation names
   * the consequence with the selection still visible behind it.
   */
  async function deleteEvents(ids: string[]) {
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const response = await fetch(`/api/events/${id}`, { method: "DELETE" })
        if (!response.ok) throw new Error(await response.text())
      })
    )
    const failed = results.filter((r) => r.status === "rejected").length
    if (failed) {
      logger.error("Error deleting events", { failed, attempted: ids.length })
      toast.error(
        failed === ids.length
          ? "Could not delete those events"
          : `Deleted ${ids.length - failed}, but ${failed} could not be removed`
      )
    } else {
      toast.success(`Deleted ${ids.length} event${ids.length === 1 ? "" : "s"}`)
    }
    router.refresh()
  }

  const columns: Column<EventRow>[] = [
    {
      key: "title",
      label: "Event",
      primary: true,
      sortType: "string",
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{row.title}</span>
          <span className="text-[0.75rem] text-muted-foreground">
            {/*
              A curated event has no host, and naming one is the leak T83 fixed
              on the mobile side: `organizer_id` on a curated row is the ADMIN
              who curated it, so rendering it under the title reads as "Sagar
              Kishore hosts this". Here that is merely wrong; on the client it
              put a founder's real name and avatar on every curated event in a
              city feed. Same column, same wrong inference, so it is named
              rather than shown.
            */}
            {[row.where, row.curation === "curated_open" ? "Listed by us" : row.host]
              .filter(Boolean)
              .join(" · ") || "No venue set"}
          </span>
        </span>
      ),
    },
    {
      key: "startTime",
      label: "When",
      sortType: "date",
      sortValue: (row) => new Date(row.startTime),
      render: (row) => <span className="tabular-nums">{row.when}</span>,
    },
    {
      key: "status",
      label: "Status",
      sortType: "string",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={STATUS_TONE[row.status] ?? "outline"} className="text-[0.6875rem]">
            {row.status}
          </Badge>
          {row.curation === "curated_open" ? (
            <Badge variant="outline" className="text-[0.6875rem]">
              unclaimed
            </Badge>
          ) : null}
          {row.curation === "curated_claimed" ? (
            <Badge variant="outline" className="text-[0.6875rem]">
              claimed
            </Badge>
          ) : null}
          {/*
            The only badge here that is a problem rather than a state.

            A published event with no coordinates and no fence 400s at the door,
            and until `canPublish()` gained a caller nothing stopped one being
            published. Those events exist; this is how you find them without
            opening every row.
          */}
          {!row.checkInReady && row.status === "published" ? (
            <Badge variant="destructive" className="text-[0.6875rem]">
              no fence
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "rsvps",
      label: "RSVPs",
      align: "right",
      sortType: "number",
      secondary: true,
    },
    {
      key: "arrivals",
      label: "Arrivals",
      align: "right",
      sortType: "number",
      /*
       * Replaces a `Capacity` column that rendered `events.current_capacity` —
       * a counter with no application writer, so it read `0` on every row of
       * every event ever created. A column of zeroes is not a neutral omission:
       * it asserts that nobody came.
       */
      render: (row) =>
        row.arrivals === 0 ? (
          <span className="text-faint-foreground">—</span>
        ) : (
          <span className="tabular-nums">{row.arrivals}</span>
        ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[0.8125rem] text-muted-foreground">
          {/*
            The cap is stated rather than hidden. A list silently truncated at
            200 reads as the whole platform — the same "no silent caps" rule the
            backend applies to every export.
          */}
          {rows.length < total
            ? `Showing the ${rows.length} most recent of ${total}`
            : `${total} event${total === 1 ? "" : "s"}`}
        </p>
        {canCreate ? (
          <Button onClick={() => router.push("/dashboard/events/new")} className="rounded-full">
            <IconPlus className="size-4" />
            Create event
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        sortable
        search
        searchPlaceholder="Search events…"
        pagination
        defaultPageSize={20}
        defaultSort={{ key: "startTime", dir: "desc" }}
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "published", label: "Published" },
              { value: "draft", label: "Draft" },
              { value: "cancelled", label: "Cancelled" },
              { value: "completed", label: "Completed" },
            ],
          },
        ]}
        rowHref={(row) => `/dashboard/events/${row.id}`}
        selectable={canCreate}
        bulkActions={
          canCreate
            ? [
                {
                  label: "Delete",
                  tone: "destructive" as const,
                  confirm:
                    "Deletes {n} event(s), their chat rooms and their attendance records. This cannot be undone.",
                  onAction: (ids: string[]) => void deleteEvents(ids),
                },
              ]
            : []
        }
        emptyState={
          <EmptyState
            icon={<IconCalendarEvent />}
            title="No events yet"
            description="Every event on the platform appears here once a host publishes one or an admin curates one."
            action={
              canCreate ? (
                <Button
                  onClick={() => router.push("/dashboard/events/new")}
                  className="rounded-full"
                >
                  <IconPlus className="size-4" />
                  Create event
                </Button>
              ) : undefined
            }
          />
        }
      />

    </div>
  )
}
