"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { IconAlertTriangle, IconLoader2, IconMicrophone2 } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/dashboard/primitives"
import { decideCreative, type CreativeQueueRow } from "@/lib/creative-review-actions"
import { formatDay } from "@/lib/dashboard-format"

/**
 * Sponsored copy awaiting review.
 *
 * The copy is shown as it will appear in the room, prefix included, because that
 * is what is being approved. Reading raw content in a form field and imagining
 * the "📣 [Sponsored]" line is how a reviewer approves something that lands
 * differently than it read.
 */
export function CreativeQueue({ rows }: { rows: CreativeQueueRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<IconMicrophone2 />}
        title="Nothing waiting"
        description="Sponsored copy cannot run until it is read by a person. Every new campaign and every edit to an existing one arrives here first."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => (
        <CreativeCard key={row.id} row={row} />
      ))}
    </div>
  )
}

function CreativeCard({ row }: { row: CreativeQueueRow }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState("")
  const [rejecting, setRejecting] = useState(false)

  function decide(decision: "approve" | "reject") {
    startTransition(async () => {
      try {
        await decideCreative(row.id, decision, note)
        toast.success(
          decision === "approve"
            ? "Approved — the organiser can switch it on."
            : "Rejected. The campaign is stopped and the reason goes to the organiser."
        )
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not record the decision.")
      }
    })
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.9375rem] font-bold">
              {row.brandName ?? "No brand"}
            </span>
            {row.campaignActive ? (
              /*
                Live means this campaign is sending an EARLIER approved revision
                right now. Rejecting stops it; approving swaps what runs. Either
                way it is not a quiet decision.
              */
              <Badge variant="destructive">Campaign is live</Badge>
            ) : null}
            {row.isLatest ? null : <Badge variant="outline">Superseded</Badge>}
            {row.hadRejection ? <Badge variant="secondary">Refused before</Badge> : null}
          </div>
          <p className="text-[0.78125rem] text-muted-foreground">
            {row.ownerName ?? "Unclaimed brand"} ·{" "}
            <Link
              href={`/dashboard/events/${row.eventId}`}
              className="underline-offset-4 hover:underline"
            >
              {row.eventTitle}
            </Link>{" "}
            · {formatDay(row.eventStart.toISOString())}
          </p>
        </div>
        <p className="text-[0.75rem] text-faint-foreground">
          Submitted {formatDay(row.createdAt.toISOString())}
        </p>
      </div>

      {/* As the room will render it. */}
      <div className="whitespace-pre-wrap rounded-md border border-border-strong bg-surface-raised px-3.5 py-3 text-[0.875rem] leading-6">
        {`📣 [Sponsored]\n${row.content}`}
      </div>

      {row.mediaUrl ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[0.75rem] font-bold uppercase tracking-wide text-faint-foreground">
            Media {row.mediaType ? `· ${row.mediaType}` : null}
          </p>
          <a
            href={row.mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[0.78125rem] underline underline-offset-4"
          >
            {row.mediaUrl}
          </a>
        </div>
      ) : null}

      {row.isLatest ? null : (
        <p className="flex items-center gap-2 text-[0.78125rem] text-muted-foreground">
          <IconAlertTriangle className="size-3.5 shrink-0 text-warning" />
          A newer revision of this campaign exists. Deciding this one records the
          verdict but does not change what runs.
        </p>
      )}

      {rejecting ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What has to change — it is sent to the organiser, and a refusal with no reason comes back word for word."
            rows={3}
            autoFocus
          />
          <p className="text-[0.75rem] text-faint-foreground">
            {note.trim().length < 10
              ? `${10 - note.trim().length} more characters needed.`
              : "Ready to send."}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {rejecting ? (
          <>
            <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
              Back
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || note.trim().length < 10}
              onClick={() => decide("reject")}
            >
              {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
              Send rejection
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={() => setRejecting(true)}>
              Reject
            </Button>
            <Button type="button" disabled={pending} onClick={() => decide("approve")}>
              {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
              Approve
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
