"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { IconShieldCheck } from "@tabler/icons-react"
import { toast } from "sonner"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { resolveReport, type ReportDecision, type ReportRow } from "./actions"

/** Above this many hours a pending report reads as overdue — same SLA as flags. */
const SLA_HOURS = 24

const TOAST: Record<ReportDecision, string> = {
  dismiss: "Report dismissed, no action taken",
  remove_message: "Message removed",
  suspend: "Account suspended and signed out",
  reinstate: "Account reinstated",
  delist: "Event delisted — removed from the feed, search and city counts",
}

export function ReportsTable({
  rows,
  status,
}: {
  rows: ReportRow[]
  status: "pending" | "reviewed" | "resolved"
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [acting, setActing] = useState<string | null>(null)

  const decide = (row: ReportRow, decision: ReportDecision) => {
    setActing(row.id)
    startTransition(async () => {
      try {
        await resolveReport(row.kind, row.id, decision)
        toast.success(TOAST[decision])
        router.refresh()
      } catch (error) {
        // Surfaced rather than swallowed: the likeliest cause is another admin
        // having already actioned this row, and the reviewer needs to know
        // their click did nothing.
        toast.error(error instanceof Error ? error.message : "Could not resolve the report")
      } finally {
        setActing(null)
      }
    })
  }

  const columns: Column<ReportRow>[] = [
    {
      key: "ageHours",
      label: "Age",
      // Sorts on the number, not the rendered "3d" / "9h" string, which would
      // order 3d before 9h.
      sortType: "number",
      hideable: false,
      render: (row) => (
        <span
          className={cn(
            "tabular-nums",
            status === "pending" && row.ageHours >= SLA_HOURS && "font-bold text-destructive"
          )}
        >
          {row.ageHours < 1 ? "<1h" : row.ageHours < 48 ? `${row.ageHours}h` : `${Math.floor(row.ageHours / 24)}d`}
        </span>
      ),
    },
    {
      key: "kind",
      label: "About",
      sortType: "string",
      render: (row) => (
        <Badge variant="secondary">
          {row.kind === "user"
            ? "Person"
            : row.kind === "event"
              ? "Event"
              : row.messageType === "private"
                ? "DM"
                : "Room message"}
        </Badge>
      ),
    },
    {
      key: "reason",
      label: "Reason",
      sortType: "string",
      render: (row) => (
        <span className="max-w-[32ch]">
          <span className="block">{row.reason}</span>
          {row.description ? (
            <span className="line-clamp-2 text-faint-foreground">{row.description}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "excerpt",
      label: "Message",
      render: (row) =>
        row.excerpt ? (
          <span className="line-clamp-2 max-w-[38ch]">
            &ldquo;{row.excerpt}&rdquo;
            {row.messageDeleted ? (
              <span className="ml-1 text-faint-foreground">(removed)</span>
            ) : null}
          </span>
        ) : row.kind === "message" ? (
          // The message was hard-deleted between the report and the review;
          // showing an empty quote would read as an empty message.
          <span className="text-faint-foreground">no longer exists</span>
        ) : (
          <span className="text-faint-foreground">—</span>
        ),
    },
    {
      key: "subjectName",
      label: "Reported",
      sortType: "string",
      render: (row) => (
        <span>
          {/*
            Not a link: there is no `/dashboard/users/[id]` route — the users
            screen is a single table — so linking would 404. The name is what
            the reviewer needs, and the suspension state travels with it.
          */}
          {row.subjectName}
          {row.subjectSuspended ? (
            <Badge variant="destructive" className="ml-1.5">
              suspended
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: "reporterName", label: "Reporter", secondary: true, sortType: "string" },
    {
      key: "eventTitle",
      label: "Event",
      secondary: true,
      render: (row) =>
        row.eventId ? (
          <Link
            href={`/dashboard/events/${row.eventId}/messaging`}
            className="hover:text-primary hover:underline"
          >
            {row.eventTitle}
          </Link>
        ) : (
          <span className="text-faint-foreground">{row.eventTitle ?? "—"}</span>
        ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      sortable: false,
      hideable: false,
      render: (row) => {
        const busy = pending && acting === row.id
        if (status !== "pending") {
          // Reinstating stays available after the fact — a suspension that can
          // only be reversed by an engineer with database access is not
          // reversible in any sense the product can rely on.
          return row.subjectSuspended && row.subjectId ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide(row, "reinstate")}>
              Reinstate
            </Button>
          ) : null
        }
        return (
          <span className="inline-flex justify-end gap-1.5">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide(row, "dismiss")}>
              Dismiss
            </Button>
            {/*
              Group rooms only: `private_messages` has no `deleted_at`, so there
              is nothing to soft-delete in a DM. The lever there is the person.
            */}
            {row.kind === "message" && row.messageType === "group" && !row.messageDeleted ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide(row, "remove_message")}>
                Remove message
              </Button>
            ) : null}
            {/*
              Delist, not cancel, and not suspend.
              `unlisted` takes it out of the feed, search and city counts and
              leaves check-ins, the room and RSVPs alone — so an admin who
              delists a listing wrongly can put it back. Marking a real event
              cancelled on a stranger's report is worse than the listing was.
              There is no Suspend here because the subject is a listing: for a
              curated event `organizer_id` is the admin who curated it, so
              wiring suspension to an event report could suspend a colleague.
            */}
            {row.kind === "event" && row.eventId ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide(row, "delist")}>
                Delist
              </Button>
            ) : null}
            {row.subjectId && !row.subjectSuspended ? (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => decide(row, "suspend")}>
                Suspend
              </Button>
            ) : null}
          </span>
        )
      },
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      sortable
      search
      searchPlaceholder="Search reports…"
      pagination
      columnMenu
      filters={[
        {
          key: "reason",
          label: "Reason",
          options: [...new Set(rows.map((r) => r.reason))].sort().map((r) => ({ value: r, label: r })),
        },
      ]}
      emptyState={
        <EmptyState
          icon={<IconShieldCheck />}
          title={status === "pending" ? "No reports waiting" : `Nothing ${status}`}
          description={
            status === "pending"
              ? "Reports arrive when someone uses Report on a person, a message, or an event in the app. Dismissing records that a human looked; delisting takes an event out of the feed, search and city counts while leaving its room and check-ins alone; suspending blocks sign-in, ends the current session, revokes app tokens, stops notifications, and removes them from every room."
              : "Reports land here once an admin has ruled on them. Reviewed means looked at, resolved means acted on."
          }
        />
      }
      footer={
        <>
          <span>
            {rows.length} {status}
            {status === "pending" ? " · oldest first, age is the SLA" : ""}
          </span>
          <span>decisions write to audit_logs</span>
        </>
      }
    />
  )
}
