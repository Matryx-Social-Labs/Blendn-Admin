"use client"

import { useRouter } from "next/navigation"

import { IconCalendarEvent } from "@tabler/icons-react"
import { toast } from "sonner"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EventAttendance, EventDate, EventStatus } from "@/components/dashboard/event-row"
import { EmptyState } from "@/components/dashboard/primitives"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { CurationState } from "@/lib/curation"
import { bulkDeleteMessage } from "@/lib/dashboard-format"
import type { EventRowData, EventRowTab } from "@/lib/event-row"
import { logger } from "@/lib/logger"

export interface EventRow extends EventRowData {
  startTime: string
  host: string | null
  curation: CurationState
}

const TABS: Array<{ key: EventRowTab; label: string; empty: string }> = [
  { key: "upcoming", label: "Upcoming", empty: "Published events that have not ended appear here, live ones first." },
  { key: "drafts", label: "Drafts", empty: "Drafts you start appear here until they are published." },
  { key: "past", label: "Past", empty: "Events that have ended or were cancelled appear here." },
]

/**
 * Soonest first while an event is ahead; most recent first once it is behind.
 * A live event starts earliest of the upcoming ones, so it leads its tab.
 */
function ordered(rows: EventRow[], tab: EventRowTab): EventRow[] {
  const at = (r: EventRow) => Date.parse(r.startTime)
  return rows
    .filter((r) => r.tab === tab)
    .sort((a, b) => (tab === "past" ? at(b) - at(a) : at(a) - at(b)))
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
   * the consequence with the selection still visible behind it. It is the only
   * place on the dashboard an event can be deleted, so the kit's list keeps it.
   */
  async function deleteEvents(ids: string[]) {
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const response = await fetch(`/api/events/${id}`, { method: "DELETE" })
        if (!response.ok) throw new Error(await response.text())
      })
    )
    const failed = results.filter((r) => r.status === "rejected").length
    if (failed) logger.error("Error deleting events", { failed, attempted: ids.length })

    const { tone, text } = bulkDeleteMessage(ids.length, failed)
    if (tone === "success") toast.success(text)
    else toast.error(text)

    // Refreshed either way: a partial success has changed the list, and leaving
    // deleted rows on screen invites deleting them again.
    router.refresh()
  }

  const columns: Column<EventRow>[] = [
    {
      key: "title",
      label: "Event",
      primary: true,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-3.5">
          <EventDate row={row} />
          <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal">
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
              {[row.when, row.where, row.curation === "curated_open" ? "Listed by us" : row.host]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {/* A narrow column hides the two cells beside this one; they come under the title instead. */}
            <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 @2xl/main:hidden">
              <EventStatus row={row} />
              <span className="flex w-32">
                <EventAttendance row={row} />
              </span>
            </span>
          </span>
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      secondary: true,
      render: (row) => (
        <span className="flex flex-wrap items-center gap-x-1.5 text-[0.8125rem]">
          {/*
            A word, not a chip: published is the ordinary case and reads quietly,
            draft is the one waiting on someone, cancelled changed what happened.
            The only badge left is the problem — "no fence": a published event
            with no pin and no fence 400s at the door.
          */}
          <EventStatus row={row} />
          {row.curation === "curated_open" ? <span className="text-muted-foreground">· unclaimed</span> : null}
          {row.curation === "curated_claimed" ? <span className="text-muted-foreground">· claimed</span> : null}
        </span>
      ),
    },
    {
      /*
       * Replaces separate RSVPs / Arrivals columns, and before them a
       * `Capacity` column that rendered `events.current_capacity` — a counter
       * with no application writer, so it read `0` on every row. Held back
       * reads the same as nobody, deliberately: the mark must not tell a night
       * of none from a night of four (SCRUM-501).
       */
      key: "attendance",
      label: "Attendance",
      secondary: true,
      render: (row) => (
        <span className="flex w-36">
          <EventAttendance row={row} />
        </span>
      ),
    },
  ]

  const counts = Object.fromEntries(TABS.map((t) => [t.key, rows.filter((r) => r.tab === t.key).length]))

  return (
    <Tabs defaultValue="upcoming" className="gap-4">
      {/* 44px targets on a touch screen; the list grows to hold them. */}
      <TabsList aria-label="Events by state" className="pointer-coarse:h-auto">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key} className="px-3 tabular-nums pointer-coarse:h-11">
            {tab.label} · {counts[tab.key]}
          </TabsTrigger>
        ))}
      </TabsList>

      {TABS.map((tab) => (
        <TabsContent key={tab.key} value={tab.key}>
          <DataTable
            label={`${tab.label} events`}
            columns={columns}
            rows={ordered(rows, tab.key)}
            search
            searchPlaceholder="Search events…"
            pagination
            defaultPageSize={20}
            rowHref={(row) => `/dashboard/events/${row.id}`}
            selectable={canCreate}
            bulkActions={
              canCreate
                ? [
                    {
                      label: "Delete",
                      tone: "destructive" as const,
                      /*
                       * What it does: the events leave the app, the lists and the
                       * reports (all scoped on `deleted_at`). It said it deleted their
                       * chat rooms and attendance records, and it deletes neither
                       * (SCRUM-441).
                       */
                      confirm:
                        "Removes {n} event(s) from the app, your lists and your reports. The dashboard can't bring them back.",
                      onAction: (ids: string[]) => void deleteEvents(ids),
                    },
                  ]
                : []
            }
            emptyState={
              <EmptyState compact icon={<IconCalendarEvent />} title="Nothing here" description={tab.empty} />
            }
            footer={
              <span>
                {/*
                  The cap is stated rather than hidden. A list silently truncated at
                  200 reads as the whole platform — the same "no silent caps" rule the
                  backend applies to every export.
                */}
                {rows.length < total
                  ? `The ${rows.length} most recent of ${total} events · `
                  : ""}
                no fence: a published event with no pin or check-in area, which the door refuses
              </span>
            }
          />
        </TabsContent>
      ))}
    </Tabs>
  )
}
