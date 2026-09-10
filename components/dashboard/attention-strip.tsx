"use client"

import Link from "next/link"

import type { AttentionQueue } from "@/lib/attention-queues"
import { byUrgency, queueAgeLabel, queueBreached, totalWaiting } from "@/lib/attention-queues"
import { cn } from "@/lib/utils"

/**
 * Everything waiting on a human, oldest breach first.
 *
 * ## What was here before
 *
 * A one-line strip counting `moderation_flags` and nothing else. On staging it
 * rendered *"Moderation queue is clear. Flags land here the moment the pipeline
 * or a user report raises one"* — true, complete, and beside a sidebar showing
 * `Claims 4` and `Applications 7`, with one report open 29 days.
 *
 * Four plus seven plus one: the single panel whose job is *is anything waiting*
 * said no while twelve things waited. It said no honestly — `moderation_flags`
 * really was empty, and a user report is not a flag.
 *
 * The fix is `lib/attention-queues.ts`, not this file: both this and the
 * sidebar badges now read one list, so a queue cannot appear in one and not the
 * other. What this component adds is the part a badge cannot carry — **age**.
 * A count says how much work there is; the age says whether you are late, and
 * late is the only thing on this screen that is anybody's fault.
 *
 * ## Empty rows stay
 *
 * A cleared queue renders with what would fill it. Dropping empty rows would
 * make "nothing is waiting" and "nobody counted" look identical on screen,
 * which is the exact failure above wearing a different hat.
 */
export function AttentionStrip({ queues, now }: { queues: AttentionQueue[]; now: Date }) {
  const total = totalWaiting(queues)
  const ordered = byUrgency(queues, now)
  const breaches = ordered.filter((q) => queueBreached(q, now))

  return (
    <section className="flex flex-col gap-3" aria-labelledby="attention-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="attention-heading" className="text-[length:var(--text-h2)] font-bold">
          {total === 0 ? "Nothing waiting on you" : `${total} waiting on you`}
        </h2>
        <p className="text-[0.8125rem] text-muted-foreground">
          {breaches.length > 0
            ? /*
               * Names the worst one rather than saying "some are overdue".
               *
               * The reader has to decide where to start, and a count of
               * breaches does not help them do that — the oldest item in the
               * tightest queue is where to start, and `byUrgency` has already
               * worked out which that is.
               */
              /*
               * The label is a mid-sentence noun everywhere else ("4 claims"),
               * so it is stored lower case and capitalised here rather than
               * kept in two spellings. It read "Oldest first. organiser
               * applications are past 3 days." before this.
               */
              `Oldest first. ${breaches[0].labelPlural.charAt(0).toUpperCase()}${breaches[0].labelPlural.slice(1)} have been waiting longer than ${
                breaches[0].slaHours >= 24
                  ? `${Math.round(breaches[0].slaHours / 24)} days`
                  : `${breaches[0].slaHours} hours`
              }.`
            : "Oldest first. Nothing is past its window."}
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {ordered.map((queue, index) => {
          const age = queueAgeLabel(queue, now)
          const breached = queueBreached(queue, now)
          return (
            <Link
              key={queue.key}
              href={queue.href}
              className={cn(
                "flex items-center gap-4 px-3.5 py-2.5 text-[0.8125rem] transition-colors",
                index > 0 && "border-t border-border",
                "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                queue.count === 0 && "text-muted-foreground"
              )}
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <b
                  className={cn(
                    "text-[length:var(--text-body)] font-bold tabular-nums",
                    queue.count === 0 && "text-success"
                  )}
                >
                  {queue.count}
                </b>
                <span className="truncate">
                  {queue.count === 1 ? queue.label : queue.labelPlural}
                </span>
              </span>
              {age ? (
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    breached ? "font-medium text-destructive" : "text-muted-foreground"
                  )}
                >
                  {age}
                </span>
              ) : (
                <span className="shrink-0 text-muted-foreground">clear</span>
              )}
              {/*
                Hidden below the container's `md`, not below the viewport's.
                The arrow is the least load-bearing thing in the row and the
                count and the age both have to survive a 375px column.
              */}
              <span className="hidden shrink-0 text-[0.75rem] text-muted-foreground @md/main:inline">
                {queue.count === 0 ? "" : "Decide →"}
              </span>
            </Link>
          )
        })}
      </div>
    </section>
  )
}
