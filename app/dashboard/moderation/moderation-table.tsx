"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { IconFlag } from "@tabler/icons-react"
import { toast } from "sonner"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatAge } from "@/lib/dashboard-format"
import { cn } from "@/lib/utils"

import { resolveFlag, type ModerationRow } from "./actions"

/** Above this many hours a pending flag reads as overdue. */
const SLA_HOURS = 24

export function ModerationTable({
  rows,
  status,
}: {
  rows: ModerationRow[]
  status: "pending" | "approved" | "rejected"
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [acting, setActing] = useState<string | null>(null)

  const decide = (flagId: string, decision: "approve" | "remove") => {
    setActing(flagId)
    startTransition(async () => {
      try {
        await resolveFlag(flagId, decision)
        toast.success(decision === "approve" ? "Flag cleared, message kept" : "Message removed")
        router.refresh()
      } catch (error) {
        // Surfaced rather than swallowed: the most likely cause is another
        // admin having already actioned this row, and the reviewer needs to
        // know their click did nothing.
        toast.error(error instanceof Error ? error.message : "Could not resolve the flag")
      } finally {
        setActing(null)
      }
    })
  }

  const columns: Column<ModerationRow>[] = [
    {
      key: "ageHours",
      label: "Age",
      // Age is the SLA, so it sorts — and it sorts on the number, not on the
      // rendered "<1h" / "3d" string, which would order 3d before 9h.
      sortType: "number",
      hideable: false,
      render: (row) => (
        <span
          className={cn(
            "tabular-nums",
            status === "pending" && row.ageHours >= SLA_HOURS && "font-bold text-destructive"
          )}
        >
          {/*
            `formatAge`, not a second copy of it. This rendered its own age
            string with a 48-hour cutover while `lib/dashboard-view.ts` had one
            with a 24-hour cutover and no caller — two answers to "how old is
            this", on the one screen whose SLA is age.
          */}
          {formatAge(row.ageHours)}
        </span>
      ),
    },
    {
      key: "excerpt",
      label: "Message",
      render: (row) => (
        <span className="line-clamp-2 max-w-[38ch]">
          &ldquo;{row.excerpt}&rdquo;
          {row.messageDeleted ? (
            <span className="ml-1 text-faint-foreground">(removed)</span>
          ) : null}
        </span>
      ),
    },
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
          row.eventTitle
        ),
    },
    {
      key: "category",
      label: "Category",
      sortType: "string",
      render: (row) => (
        <span
          className={
            (row.confidence ?? 0) >= 0.9
              ? "text-[0.8125rem] font-bold text-destructive"
              : "text-[0.8125rem] text-muted-foreground"
          }
        >
          {row.category}
        </span>
      ),
    },
    {
      key: "authorName",
      label: "Author",
      secondary: true,
      sortType: "string",
      /*
       * The person, beside the name. A harassment report shows on its own at
       * any volume — the schema's rule, and the reason it is not folded into
       * the score. `poor` needs four ratings before it can say anything, which
       * is what stops one bad night reading as a pattern.
       */
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {row.authorName}
          {row.trust.harassment > 0 ? (
            <Badge variant="destructive">
              {row.trust.harassment} harassment
            </Badge>
          ) : null}
          {row.trust.band === "poor" || row.trust.band === "mixed" ? (
            <Badge variant="secondary">
              {row.trust.band} · {row.trust.ratings}
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: "source", label: "Source", secondary: true, sortType: "string" },
    {
      key: "confidence",
      label: "Confidence",
      align: "right",
      secondary: true,
      sortType: "number",
      render: (row) => (row.confidence === null ? "—" : row.confidence.toFixed(2)),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      sortable: false,
      hideable: false,
      render: (row) =>
        status === "pending" ? (
          <span className="inline-flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={pending && acting === row.id}
              onClick={() => decide(row.id, "approve")}
            >
              Keep
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending && acting === row.id}
              onClick={() => decide(row.id, "remove")}
            >
              Remove
            </Button>
          </span>
        ) : null,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      sortable
      // No defaultSort: the server already returns oldest-first, and age IS the
      // SLA. Sorting here is for exploring; the third click returns to the
      // queue order that matters.
      search
      searchPlaceholder="Search flags…"
      pagination
      columnMenu
      filters={[
        {
          key: "category",
          label: "Category",
          options: [...new Set(rows.map((r) => r.category))].sort().map((c) => ({
            value: c,
            label: c,
          })),
        },
      ]}
      emptyState={
        <EmptyState
          icon={<IconFlag />}
          title={status === "pending" ? "No flags pending" : `Nothing ${status}`}
          description={
            status === "pending"
              ? "Flags appear when the moderation pipeline or a user report marks a message for review. Decisions move to the other tabs and are written to the audit log."
              : "Reviewed flags land here once an admin has ruled on them."
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
