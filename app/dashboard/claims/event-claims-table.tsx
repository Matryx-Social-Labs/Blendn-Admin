"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { IconAlertTriangle, IconCircleCheck, IconExternalLink, IconGavel } from "@tabler/icons-react"
import { toast } from "sonner"

import { Callout, Panel } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FLAG_COPY } from "@/lib/claim-flags"
import { cn } from "@/lib/utils"

import { decideEventClaim, type EventClaimRow } from "@/lib/event-claim-actions"
import { refusalMessage } from "@/lib/refusal"

/** Above this many hours a pending claim reads as overdue. */
const SLA_HOURS = 48

/**
 * Deciding whether an event belongs to somebody — one bordered card per claim.
 *
 * ## Not a `DataTable`
 *
 * The other admin queues are tables because their rows are comparable — one
 * flag against another. A claim is not scanned, it is *read*: the flags, the
 * note, the source listing and the claim number only mean anything together,
 * and a row that hides the note behind a column menu is a row somebody approves
 * without reading it.
 *
 * The moderation queue reached the same conclusion for the same reason.
 *
 * ## The flags are the screen
 *
 * `source_is_aggregator` first, always, because it invalidates the evidence
 * under it — a reviewer who reads "email matches source" and stops has been
 * misled. The copy lives in `FLAG_COPY` beside the rule that emits it, so a new
 * flag cannot ship without a sentence explaining itself.
 */
export function EventClaimsTable({ rows }: { rows: EventClaimRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [acting, setActing] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  const decide = (claimId: string, decision: "approve" | "decline") => {
    setActing(claimId)
    startTransition(async () => {
      try {
        const { notified } = await decideEventClaim(claimId, decision, notes[claimId])
        toast.success(
          decision === "approve"
            ? "Handed over"
            : notified
              ? "Claim declined — the reason has been emailed to the claimant."
              : "Claim declined — email is not configured, so nothing was sent. Tell them yourself."
        )
        router.refresh()
      } catch (error) {
        /*
         * Surfaced, not swallowed. The likeliest causes are another admin
         * having decided this already, or the event having started since the
         * page loaded — and the reviewer needs to know which.
         */
        toast.error(refusalMessage(error, "Could not decide this claim"))
      } finally {
        setActing(null)
      }
    })
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<IconGavel className="size-5" />}
        title="Nothing waiting"
        description="Claims on curated events land here. Nobody is waiting on you."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3.5">
      {rows.map((row) => {
        const overdue = row.ageHours >= SLA_HOURS
        const busy = pending && acting === row.id
        return (
          <Panel key={row.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="text-[0.9375rem] font-bold">
                <Link href={`/dashboard/events/${row.eventId}`} className="underline-offset-4 hover:underline">
                  {row.eventTitle}
                </Link>
                {row.eventCity ? (
                  <span className="ml-2 font-normal text-muted-foreground">{row.eventCity}</span>
                ) : null}
              </h2>
              <span
                className={cn(
                  "text-[0.8125rem] tabular-nums",
                  overdue ? "font-bold text-destructive" : "text-muted-foreground"
                )}
              >
                waiting {row.ageHours}h
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem]">
              <b className="font-medium">{row.orgName ?? "No account yet"}</b>
              <span className="text-muted-foreground">{row.contactEmail}</span>
              {row.claimNumber > 1 ? (
                /*
                 * The number an upsert would have erased. `venue_claims` updates
                 * in place; here a third claim on one event is the reviewer's
                 * most useful fact.
                 */
                <Badge variant="secondary" className="text-[0.6875rem]">
                  claim #{row.claimNumber}
                </Badge>
              ) : null}
              {row.sourceUrl ? (
                <a
                  href={row.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                >
                  source <IconExternalLink aria-hidden className="size-3.5" />
                </a>
              ) : null}
            </div>

            {row.note ? <p className="text-[0.84375rem] leading-[21px] text-muted-foreground">{row.note}</p> : null}

            {row.flags.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {row.flags.map((flag) => {
                  // The one that invalidates everything under it, and the one credential.
                  const against = flag === "source_is_aggregator"
                  const verified = flag === "domain_verified_for_org"
                  const Icon = verified ? IconCircleCheck : IconAlertTriangle
                  return (
                    <li
                      key={flag}
                      className={cn(
                        "flex items-start gap-2 text-[0.8125rem]",
                        against ? "font-medium text-destructive" : verified ? "text-success" : "text-muted-foreground"
                      )}
                    >
                      <Icon
                        aria-hidden
                        className={cn("mt-0.5 size-3.5 shrink-0", !against && !verified && "text-warning")}
                      />
                      {/* A stored key this build has no sentence for reads as itself, never as a blank line. */}
                      {FLAG_COPY[flag] ?? flag}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-[0.8125rem] text-faint-foreground">
                No automatic signals either way — decide on the note and the source.
              </p>
            )}

            {row.blocked ? (
              /*
               * Shown before the buttons, not after a failed submit.
               *
               * `decideEventClaim` re-checks and throws, which is correct and a
               * terrible way to learn it. A reviewer should see that a row
               * cannot be actioned before they read it.
               */
              <Callout>
                {row.blocked === "room_open"
                  ? "This event is running. Decide once the room has closed — approving now would hand over the attendee list for people currently in the building."
                  : "Somebody else's claim was approved first. Decline this one."}
              </Callout>
            ) : null}

            {/*
              The reason field stays open rather than behind Decline, unlike the
              venue and brand queues: a note written on a hand-over reaches the
              claimant in the approval email and is kept as the claim's
              `decision_note`, so it is not only a decline's.
            */}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={notes[row.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [row.id]: e.target.value }))}
                placeholder="Reason — sent to the claimant, required to decline"
                aria-label={`Decision note for ${row.eventTitle}`}
                /*
                 * A floor, not `min-w-0` -- same bug as the curation row. A
                 * `flex-1` item that may shrink to zero always "fits", so
                 * `flex-wrap` never moved the buttons down and at 375px the
                 * field squeezed until its placeholder read "Reason -- sent to
                 * the claimant, requi". The placeholder states the one rule
                 * that governs this control (required to decline), so truncating
                 * it hides the rule.
                 */
                className="h-9 min-w-[15rem] flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => decide(row.id, "decline")}
              >
                Decline
              </Button>
              <Button
                size="sm"
                disabled={busy || row.blocked !== null}
                onClick={() => decide(row.id, "approve")}
              >
                Hand over
              </Button>
            </div>
          </Panel>
        )
      })}
    </div>
  )
}
