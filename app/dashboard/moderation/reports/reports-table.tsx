"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { IconShieldCheck } from "@tabler/icons-react"
import { toast } from "sonner"

import { Facts, Panel } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatAge } from "@/lib/dashboard-format"
import { cn } from "@/lib/utils"

import { resolveReport, type ReportDecision, type ReportRow } from "./actions"
import { refusalMessage } from "@/lib/refusal"

/** Above this many hours a pending report reads as overdue — same SLA as flags. */
const SLA_HOURS = 24

const TOAST: Record<ReportDecision, string> = {
  dismiss: "Report dismissed, no action taken",
  remove_message: "Message removed",
  suspend: "Account suspended and signed out",
  reinstate: "Account reinstated",
  delist: "Event delisted — removed from the feed, search and city counts",
  hide_crew: "Crew hidden — no card, likes or Blends; its members keep their crew",
  dissolve_crew: "Crew dissolved and its chat archived",
}

/**
 * The reports queue, one bordered card per report.
 *
 * A table, until step 18. A report is a decision with prose in it — the
 * reason, the reporter's words, the message — and a row clamps all three to
 * two lines beside six columns. The kit reads each one as a card, and so does
 * the reviewer.
 */
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
        toast.success(
          decision === "remove_message" && row.messageType === "board_post"
            ? "Post removed from the board"
            : TOAST[decision]
        )
        router.refresh()
      } catch (error) {
        // Surfaced rather than swallowed: the likeliest cause is another admin
        // having already actioned this row, and the reviewer needs to know
        // their click did nothing.
        toast.error(refusalMessage(error, "Could not resolve the report"))
      } finally {
        setActing(null)
      }
    })
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<IconShieldCheck />}
        title={status === "pending" ? "No reports waiting" : `Nothing ${status}`}
        description={
          status === "pending"
            ? "Reports arrive when someone uses Report on a person, a message, a board post or ask, a crew, or an event in the app."
            : "Reports land here once an admin has ruled on them. Reviewed means looked at, resolved means acted on."
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <ReportCard
          key={`${row.kind}:${row.id}`}
          row={row}
          status={status}
          busy={pending && acting === row.id}
          onDecide={(decision) => decide(row, decision)}
        />
      ))}
      <p className="text-[0.8125rem] text-muted-foreground">
        {rows.length} {status}
        {status === "pending" ? " · oldest first, age is the SLA" : ""} · decisions write to the audit log
      </p>
      {/*
        What each lever does, once, under the queue rather than in a tooltip on
        every button. The suspension sentence used to say it "blocks the
        account everywhere and signs it out" while doing neither; a moderator
        reading that believed they had acted.
      */}
      <p className="text-[0.75rem] leading-5 text-faint-foreground">
        Dismissing records that a human looked. Delisting takes an event out of the feed, search and city counts and
        leaves its room and check-ins alone. Hiding a crew keeps it for its members, and suspending blocks sign-in, ends
        the current session, revokes app tokens, stops notifications and removes them from every room — Reinstate
        reverses it.
      </p>
    </div>
  )
}

/** What the report is about, in the word the app uses for it. */
function aboutLabel(row: ReportRow): string {
  if (row.kind === "user") return "Person"
  if (row.kind === "event") return row.room ? "Room" : "Event"
  if (row.messageType === "private") return "DM"
  // The kind is the point: an offer of a seat is two strangers arranging to
  // meet away from a venue.
  if (row.messageType === "board_post") return `Board · ${row.boardKind ?? "post"}`
  if (row.messageType === "board_request") return "Board ask"
  if (row.messageType === "crew") return "Crew"
  return "Room message"
}

function ReportCard({
  row,
  status,
  busy,
  onDecide,
}: {
  row: ReportRow
  status: "pending" | "reviewed" | "resolved"
  busy: boolean
  onDecide: (decision: ReportDecision) => void
}) {
  const overdue = status === "pending" && row.ageHours >= SLA_HOURS
  return (
    <Panel>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={cn("text-[0.75rem] font-bold tabular-nums", overdue ? "text-destructive" : "text-muted-foreground")}>
          {formatAge(row.ageHours)}
        </span>
        <Badge variant="outline">{aboutLabel(row)}</Badge>
        <h2 className="text-[0.90625rem] font-bold">{row.reason}</h2>
        {row.sameSubject > 1 ? (
          // How many people reported the same thing: a pile-on is one
          // subject, not a column of separate rows to read one by one.
          <span className="text-[0.8125rem] font-medium">{row.sameSubject} reports</span>
        ) : null}
      </div>

      {row.description ? <p className="text-[0.84375rem] text-muted-foreground">{row.description}</p> : null}

      <Excerpt row={row} />

      <Facts
        cols={3}
        items={[
          {
            label: "Reported",
            value: (
              <>
                {/*
                  Not a link: there is no `/dashboard/users/[id]` route — the
                  users screen is a single table — so linking would 404. The
                  name is what the reviewer needs, and the suspension state
                  travels with it.
                */}
                {row.subjectName}
                {row.subjectSuspended ? (
                  <Badge variant="destructive" className="ml-1.5">
                    suspended
                  </Badge>
                ) : null}
              </>
            ),
          },
          { label: "Reporter", value: row.reporterName },
          {
            label: "Event",
            value: row.eventId ? (
              <Link href={`/dashboard/events/${row.eventId}/messaging`} className="hover:text-primary hover:underline">
                {row.eventTitle}
              </Link>
            ) : (
              row.eventTitle
            ),
          },
        ]}
      />

      <Actions row={row} status={status} busy={busy} onDecide={onDecide} />
    </Panel>
  )
}

function Excerpt({ row }: { row: ReportRow }) {
  if (row.excerpt) {
    return (
      <blockquote className="whitespace-pre-wrap break-words rounded-lg bg-surface-raised px-3 py-2.5 text-[0.84375rem]">
        &ldquo;{row.excerpt}&rdquo;
        {row.messageDeleted ? <span className="ml-1 text-faint-foreground">(removed)</span> : null}
      </blockquote>
    )
  }
  // The reported post or ask is gone with its author's account, or the message
  // was hard-deleted between the report and the review: an empty quote would
  // read as an empty message.
  if (row.gone || (row.kind === "message" && row.messageType !== "board_request")) {
    return <p className="text-[0.8125rem] text-faint-foreground">The message no longer exists.</p>
  }
  // An ask's message is optional; most say nothing beyond the ask.
  if (row.messageType === "board_request") {
    return <p className="text-[0.8125rem] text-faint-foreground">They asked without a message.</p>
  }
  return null
}

function Actions({
  row,
  status,
  busy,
  onDecide,
}: {
  row: ReportRow
  status: "pending" | "reviewed" | "resolved"
  busy: boolean
  onDecide: (decision: ReportDecision) => void
}) {
  if (status !== "pending") {
    // Reinstating stays available after the fact — a suspension that can only
    // be reversed by an engineer with database access is not reversible in any
    // sense the product can rely on.
    return row.subjectSuspended && row.subjectId ? (
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide("reinstate")}>
          Reinstate
        </Button>
      </div>
    ) : null
  }
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide("dismiss")}>
        Dismiss
      </Button>
      {/*
        Group rooms only: `private_messages` has no `deleted_at`, so there is
        nothing to soft-delete in a DM. The lever there is the person.
      */}
      {row.kind === "message" && row.messageType === "group" && !row.messageDeleted ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide("remove_message")}>
          Remove message
        </Button>
      ) : null}
      {/*
        A board post, not a board ask: an ask went to one person, like a DM, so
        the lever there is the person. Offered on a post its author already
        withdrew, too: until a moderator marks it, the record says only that the
        author took it down. Not offered once it is removed, or once it is gone
        with an erased account.
      */}
      {row.messageType === "board_post" && row.removable ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide("remove_message")}>
          Remove post
        </Button>
      ) : null}
      {/*
        A crew's card (C12): the subject is the crew, not a person, so no
        Suspend. Hide keeps the crew for its members and takes it off every
        stranger's screen; Dissolve ends it. Neither is offered once the crew
        has dissolved.
      */}
      {row.crew && !row.crew.dissolved && !row.crew.hidden ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide("hide_crew")}>
          Hide crew
        </Button>
      ) : null}
      {row.crew && !row.crew.dissolved ? (
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => onDecide("dissolve_crew")}>
          Dissolve crew
        </Button>
      ) : null}
      {/*
        Delist, not cancel, and not suspend. `unlisted` takes it out of the
        feed, search and city counts and leaves check-ins, the room and RSVPs
        alone — so an admin who delists a listing wrongly can put it back.
        Marking a real event cancelled on a stranger's report is worse than the
        listing was. There is no Suspend here because the subject is a listing:
        for a curated event `organizer_id` is the admin who curated it, so
        wiring suspension to an event report could suspend a colleague.
      */}
      {row.kind === "event" && row.eventId && !row.room ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide("delist")}>
          Delist
        </Button>
      ) : null}
      {row.subjectId && !row.subjectSuspended ? (
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => onDecide("suspend")}>
          Suspend
        </Button>
      ) : null}
    </div>
  )
}
