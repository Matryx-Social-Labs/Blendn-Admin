import Link from "next/link"
import { IconAlertTriangle, IconCheck, IconEdit, IconMessage2, IconUsers } from "@tabler/icons-react"

import { HeroMetric, MetricTile } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { STATE_QUESTION } from "@/lib/event-phase"
import type { EventOverview } from "@/lib/event-overview"

/**
 * The Overview tab — the page's front door.
 *
 * This screen used to be the edit form. Opening an event to see how it was
 * doing put you in a seven-stage editor, which answers "what did I type" rather
 * than "is this working".
 *
 * **Exactly one hero metric**, carrying the gradient, and it changes with the
 * lifecycle state: what is blocking publication for a draft, fill for an
 * upcoming event, who is in the room live, turn-up once it is over. If a second
 * element wanted the gradient the screen would have two priorities and one of
 * them would be wrong.
 */
export function Overview({
  overview,
  eventId,
  canEdit,
  venueName,
}: {
  overview: EventOverview
  eventId: string
  canEdit: boolean
  venueName: string | null
}) {
  const { state, hero, tiles, blockers, publishable } = overview
  const blocking = blockers.filter((b) => b.blocking)
  const advisory = blockers.filter((b) => !b.blocking)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[0.8125rem] text-muted-foreground">{STATE_QUESTION[state]}</p>
        {canEdit ? (
          <Button asChild variant="outline" size="sm">
            {/* The handoff to the editor. Overview answers the question; the
                editor changes the answer. */}
            <Link href={`/dashboard/events/${eventId}/edit`}>
              <IconEdit className="size-4" />
              Edit event
            </Link>
          </Button>
        ) : null}
      </div>

      <HeroMetric
        eyebrow={hero.label}
        value={hero.value}
        description={hero.hint}
      />

      <div className="flex flex-wrap gap-1">
        {tiles.map((t) => (
          <MetricTile key={t.label} label={t.label} value={t.value} hint={t.hint} />
        ))}
      </div>

      {state === "draft" ? (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[0.9375rem] font-bold">Before it can go out</h3>
            {publishable ? (
              <Badge>
                <IconCheck className="size-3" />
                Nothing blocking
              </Badge>
            ) : (
              <Badge variant="destructive">{blocking.length} to fix</Badge>
            )}
          </div>

          {blockers.length === 0 ? (
            <p className="text-[0.8125rem] text-muted-foreground">
              Everything is filled in. Publish from the editor when you are ready.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {[...blocking, ...advisory].map((b) => (
                <li key={b.key} className="flex items-start gap-2.5">
                  {b.blocking ? (
                    <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  ) : (
                    <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  )}
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[0.8125rem] font-medium">
                      {b.label}
                      {b.blocking ? null : (
                        <span className="ml-2 text-[0.71875rem] font-normal text-faint-foreground">
                          optional
                        </span>
                      )}
                    </span>
                    <span className="text-[0.75rem] text-muted-foreground">{b.hint}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {!canEdit ? (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-5">
          <h3 className="text-[0.9375rem] font-bold">Your access to this event</h3>
          <p className="max-w-prose text-[0.8125rem] text-muted-foreground">
            It is running at {venueName ? <b>{venueName}</b> : "your venue"}, so you get the live
            view, the attendee count and the chatroom. Editing, publishing and cancelling belong
            to whoever runs the event — that is the relationship, not a missing button.
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/events/${eventId}?tab=attendees`}>
                <IconUsers className="size-4" />
                Attendees
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/events/${eventId}?tab=chat`}>
                <IconMessage2 className="size-4" />
                Chatroom
              </Link>
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
