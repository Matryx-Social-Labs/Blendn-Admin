import Link from "next/link"
import { IconAlertTriangle, IconEdit, IconMessage2, IconUsers } from "@tabler/icons-react"

import { AttendancePanel } from "@/components/dashboard/attendance-panel"
import { ConnectionsPanel } from "@/components/dashboard/connections-panel"
import { TurnedAwayPanel } from "@/components/dashboard/turned-away-panel"
import { Panel } from "@/components/dashboard/kit"
import { HeroMetric } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import type { EventAttendance } from "@/lib/attendance"
import type { EventRefusals } from "@/lib/check-in-refusals"
import type { ConnectionMetrics } from "@/lib/connection-metrics"
import type { EventOverview } from "@/lib/event-overview"
import { cn } from "@/lib/utils"

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
  attendance,
  connections,
  turnedAway,
}: {
  overview: EventOverview
  eventId: string
  canEdit: boolean
  venueName: string | null
  /** Null before the event has run — there is nothing to count yet. */
  attendance: EventAttendance | null
  connections: ConnectionMetrics | null
  /** Null only for a draft: an upcoming event can already have turned people away (SCRUM-494). */
  turnedAway: EventRefusals | null
}) {
  const { state, hero, tiles, blockers, publishable } = overview
  const blocking = blockers.filter((b) => b.blocking)
  const advisory = blockers.filter((b) => !b.blocking)

  return (
    <div className="flex flex-col gap-5">
      {/* The hero answers the lit phase's question; the glance beside it is
          the rest of the facts, as the kit lays them out. */}
      <div className="grid gap-5 @3xl/main:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <HeroMetric eyebrow={hero.label} value={hero.value} description={hero.hint} />
        {state === "draft" ? (
          <Panel title="Before it can go out" hint={publishable ? "nothing blocking" : `${blocking.length} to fix`}>
            {blockers.length === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground">Nothing is stopping it. Publish it from the editor.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {[...blocking, ...advisory].map((b) => (
                  <li key={b.key} className="flex items-start gap-2.5">
                    <IconAlertTriangle
                      aria-hidden
                      className={cn("mt-0.5 size-4 shrink-0", b.blocking ? "text-destructive" : "text-warning")}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[0.8125rem] font-medium">
                        {b.label}
                        {b.blocking ? null : (
                          <span className="ml-2 text-[0.71875rem] font-normal text-faint-foreground">optional</span>
                        )}
                      </span>
                      <span className="text-[0.75rem] text-muted-foreground">{b.hint}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/* Publish lives in the editor, beside the readiness list that
                explains what is missing. One button there, not a second one here. */}
            {canEdit ? (
              <Button asChild size="sm" className="self-start pointer-coarse:h-11">
                <Link href={`/dashboard/events/${eventId}/edit`}>
                  <IconEdit aria-hidden className="size-4" />
                  Open editor
                </Link>
              </Button>
            ) : null}
          </Panel>
        ) : (
          <Panel title="At a glance">
            <dl className="flex flex-col gap-2.5">
              {tiles.map((t) => (
                <div key={t.label} className="flex items-baseline justify-between gap-4 text-[0.84375rem]">
                  <dt className="text-muted-foreground">
                    {t.label}
                    {t.hint ? <span className="block text-[0.71875rem] text-faint-foreground">{t.hint}</span> : null}
                  </dt>
                  <dd className="shrink-0 font-medium tabular-nums">{t.value ?? "—"}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        )}
      </div>

      {/* Below the hero, deliberately. This answers "who came", the hero
          answers whatever the lifecycle state makes most urgent. */}
      {attendance ? (
        <Panel>
          <AttendancePanel attendance={attendance} live={state === "live"} />
        </Panel>
      ) : null}

      {/* Between who came and who met: who could not get in. Rendered only when
          somebody was refused — "0 turned away" is a panel asserting the absence
          of a problem nobody asked about. */}
      {turnedAway && turnedAway.people > 0 ? (
        <Panel>
          <TurnedAwayPanel refusals={turnedAway} eventId={eventId} canEdit={canEdit} />
        </Panel>
      ) : null}

      {/* Below attendance, deliberately. Who came is the question an organiser
          asks first; whether they met anyone is the one that decides whether to
          run it again. */}
      {connections ? (
        <Panel>
          <ConnectionsPanel metrics={connections} />
        </Panel>
      ) : null}

      {!canEdit ? (
        <Panel title="Your access to this event">
          <p className="max-w-prose text-[0.8125rem] text-muted-foreground">
            It is running at {venueName ? <b>{venueName}</b> : "your venue"}, so you get the live
            view, the attendee count and the chatroom. Editing, publishing and cancelling belong
            to whoever runs the event — that is the relationship, not a missing button.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm" className="pointer-coarse:h-11">
              <Link href={`/dashboard/events/${eventId}?tab=attendees`}>
                <IconUsers aria-hidden className="size-4" />
                Attendees
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="pointer-coarse:h-11">
              <Link href={`/dashboard/events/${eventId}/messaging`}>
                <IconMessage2 aria-hidden className="size-4" />
                Room chat
              </Link>
            </Button>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
