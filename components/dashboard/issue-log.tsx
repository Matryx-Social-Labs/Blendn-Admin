"use client"

import { useState, useTransition } from "react"

import { acknowledgeIssue } from "@/app/dashboard/events/[id]/issue-actions"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/dashboard/primitives"
import type { IssueRow } from "@/lib/event-issues"
import { issueOpenedLabel } from "@/lib/issue-timestamp"
import { cn } from "@/lib/utils"

/**
 * What happened tonight, whether or not anyone was watching.
 *
 * The alerts above this are derived from the live snapshot in a `useMemo`, so
 * they exist only while the tab is open. That was the *only* form they took: an
 * `over_capacity` breach at 23:40 was gone at 23:45 with no record it had
 * happened, on the screen a venue's crowd-safety decisions come from.
 *
 * A server sweep now records the same rules into `event_issues`, and this is
 * the reader. Open first, then resolved — because "the queue cleared itself
 * twenty minutes ago" is the most useful thing this panel can tell somebody who
 * has just walked in.
 */
function duration(from: string, to: string): string {
  const mins = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m`
}

export function IssueLog({ issues }: { issues: IssueRow[] }) {
  const [pending, startTransition] = useTransition()
  const [acked, setAcked] = useState<Set<string>>(new Set())

  if (issues.length === 0) {
    return (
      <EmptyState
        title="Nothing has gone wrong tonight"
        description="Entry backing up, capacity, people leaving early, safety reports and the room going quiet are all being watched — whether or not this tab is open."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {issues.map((i) => {
        const open = i.resolvedAt === null
        const isAcked = i.acknowledgedAt !== null || acked.has(i.id)
        return (
          <li
            key={i.id}
            className={cn(
              "rounded-lg border px-4 py-3",
              open && i.severity === "critical"
                ? "border-[color-mix(in_oklch,var(--primary)_55%,transparent)]"
                : "border-border",
              !open && "opacity-70"
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">{i.title}</span>
              <span className="text-[0.8125rem] text-muted-foreground tabular-nums">
                {/* Opened, and how long it lasted — a five-minute queue and a
                    two-hour one are different nights. */}
                {issueOpenedLabel(i.openedAt)}
                {open
                  ? ` · ongoing ${duration(i.openedAt, i.lastSeenAt)}`
                  : ` · lasted ${duration(i.openedAt, i.resolvedAt!)}`}
              </span>
            </div>
            <p className="mt-1 text-[0.875rem] text-muted-foreground">{i.body}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {!open ? (
                <span className="text-[0.75rem] text-faint-foreground">Cleared on its own</span>
              ) : null}
              {isAcked ? (
                <span className="text-[0.75rem] text-faint-foreground">Seen</span>
              ) : (
                /*
                 * Acknowledging is separate from resolving on purpose. The
                 * sweep decides when a condition stops; this records that a
                 * person looked, which is the fact worth having afterwards.
                 */
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      await acknowledgeIssue(i.id)
                      setAcked((prev) => new Set(prev).add(i.id))
                    })
                  }
                >
                  Mark as seen
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
