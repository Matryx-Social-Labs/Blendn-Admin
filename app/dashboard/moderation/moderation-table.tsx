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
      render: (row) => (
        <Badge variant={(row.confidence ?? 0) >= 0.9 ? "destructive" : "secondary"}>
          {row.category}
        </Badge>
      ),
    },
    { key: "authorName", label: "Author", secondary: true },
    { key: "source", label: "Source", secondary: true },
    {
      key: "confidence",
      label: "Confidence",
      align: "right",
      secondary: true,
      render: (row) => (row.confidence === null ? "—" : row.confidence.toFixed(2)),
    },
    {
      key: "actions",
      label: "",
      align: "right",
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
