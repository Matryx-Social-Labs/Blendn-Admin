"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { IconCheck, IconExternalLink, IconGavel } from "@tabler/icons-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FLAG_COPY } from "@/lib/claim-flags"
import { cn } from "@/lib/utils"

import { decideEventClaim, type EventClaimRow } from "@/lib/event-claim-actions"

/** Above this many hours a pending claim reads as overdue. */
const SLA_HOURS = 48

/**
 * Deciding whether an event belongs to somebody.
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
        await decideEventClaim(claimId, decision, notes[claimId])
        toast.success(decision === "approve" ? "Handed over" : "Claim declined")
        router.refresh()
      } catch (error) {
        /*
         * Surfaced, not swallowed. The likeliest causes are another admin
         * having decided this already, or the event having started since the
         * page loaded — and the reviewer needs to know which.
         */
        toast.error(error instanceof Error ? error.message : "Could not decide this claim")
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
    <ul className="flex flex-col gap-3">
      {rows.map((row) => {
        const overdue = row.ageHours >= SLA_HOURS
        const busy = pending && acting === row.id
        return (
          <li
            key={row.id}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-bold">
                <Link href={`/dashboard/events/${row.eventId}`} className="hover:underline">
                  {row.eventTitle}
                </Link>
                {row.eventCity ? (
                  <span className="ml-2 font-normal text-muted-foreground">{row.eventCity}</span>
                ) : null}
              </h3>
              <span
                className={cn(
                  "text-[0.75rem] tabular-nums",
                  overdue ? "font-medium text-destructive" : "text-muted-foreground"
                )}
              >
                waiting {row.ageHours}h
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
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
                  source <IconExternalLink className="size-3.5" />
                </a>
              ) : null}
            </div>

            {row.note ? (
              <p className="text-sm leading-relaxed text-muted-foreground">{row.note}</p>
            ) : null}

            {row.flags.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {row.flags.map((flag) => (
                  <li
                    key={flag}
                    className={cn(
                      "text-[0.75rem]",
                      // The one that invalidates everything under it.
                      flag === "source_is_aggregator"
                        ? "font-medium text-destructive"
                        : flag === "domain_verified_for_org"
                          ? "text-success"
                          : "text-muted-foreground"
                    )}
                  >
                    {FLAG_COPY[flag]}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.75rem] text-faint-foreground">
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
              <p className="rounded border border-border bg-surface-raised px-3 py-2 text-[0.75rem] text-muted-foreground">
                {row.blocked === "room_open"
                  ? "This event is running. Decide once the room has closed — approving now would hand over the attendee list for people currently in the building."
                  : "Somebody else's claim was approved first. Decline this one."}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <input
                value={notes[row.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [row.id]: e.target.value }))}
                placeholder="Reason — sent to the claimant, required to decline"
                aria-label={`Decision note for ${row.eventTitle}`}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2.5 py-1.5 text-[0.8125rem]"
              />
              <Button
                size="sm"
                disabled={busy || row.blocked !== null}
                onClick={() => decide(row.id, "approve")}
              >
                <IconCheck className="size-4" />
                Hand over
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => decide(row.id, "decline")}
              >
                Decline
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
