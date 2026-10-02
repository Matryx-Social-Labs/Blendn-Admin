import Link from "next/link"
import { IconArrowRight, IconCheck, IconChevronRight, IconPlus } from "@tabler/icons-react"

import { PacingChart } from "@/components/dashboard/charts"
import { EventRow } from "@/components/dashboard/event-row"
import { KpiStrip, LiveDot, Panel } from "@/components/dashboard/kit"
import { HeroMetric, RatingBars } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import type { LiveEvent, OrganizerOverview } from "@/lib/dashboard-types"
import { formatNumber, formatPct } from "@/lib/dashboard-format"
import { tileDelta } from "@/lib/metric-delta"
import { setupChecklist } from "@/lib/setup-checklist"
import { cn } from "@/lib/utils"

/**
 * Organiser overview, in the kit's order: what is live, whether the next night
 * is filling, what is left to set up, how the last month went, and what is
 * coming.
 *
 * One HeroMetric — the next event's fill — and the live banner above it only
 * while a night runs. No paywall here: everything on this screen is free
 * (step 16 decides what Analytics adds), and none of it names a person.
 */
export function OverviewOrganizer({ data, canCreate = true }: { data: OrganizerOverview; canCreate?: boolean }) {
  // Where "Create event" would be, for an account that cannot save one: the
  // page that explains why (SCRUM-145).
  const createAction = canCreate ? null : (
    <Button asChild size="sm" variant="outline">
      <Link href="/dashboard/organisation">Join an organisation to create events</Link>
    </Button>
  )
  const { nextEvent } = data
  const steps = setupChecklist(data.setup)
  const stepsLeft = steps.filter((s) => !s.done).length

  return (
    <div className="flex flex-col gap-6">
      {data.live ? <LiveBanner live={data.live} /> : null}

      {/* The checklist sits beside the hero until it is done, then gets out of the way. */}
      <div className={cn("grid gap-5", stepsLeft > 0 && "@3xl/main:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]")}>
        {nextEvent ? (
          <HeroMetric
            // The venue only when the title does not already say it — "Sunset
            // Sessions at The Humming Tree · The Humming Tree" read twice.
            eyebrow={`Next up · ${nextEvent.dayLabel} · ${nextEvent.title}${
              nextEvent.venue !== "Venue TBD" && !nextEvent.title.includes(nextEvent.venue)
                ? ` · ${nextEvent.venue}`
                : ""
            }`}
            value={nextEvent.fillPct === null ? formatNumber(nextEvent.going) : formatPct(nextEvent.fillPct)}
            unit={
              nextEvent.fillPct === null
                ? `going · ${daysToGo(nextEvent.daysOut)}`
                : `filled · ${daysToGo(nextEvent.daysOut)}`
            }
            progress={nextEvent.fillPct}
            // The value above already says going (or fill, with going as the
            // "N of capacity" here). Never the same number twice on one card.
            description={[
              ...(nextEvent.capacity
                ? [`${formatNumber(nextEvent.going)} of ${formatNumber(nextEvent.capacity)} going`]
                : []),
              `${formatNumber(nextEvent.maybe)} maybe`,
              `${formatNumber(nextEvent.favourites)} saved`,
            ]
              .join(" · ")
              .concat(nextEvent.pacingNote ? `. ${nextEvent.pacingNote}` : "")}
            action={
              <Button asChild size="sm" variant="secondary" className="pointer-coarse:h-11">
                <Link href={`/dashboard/events/${nextEvent.id}`}>Open event</Link>
              </Button>
            }
          />
        ) : (
          <HeroMetric
            eyebrow="Next up"
            value="—"
            description="No upcoming event. Publish one and RSVPs, saves and the pacing curve appear here."
            action={
              createAction ?? (
                <Button asChild size="sm">
                  <Link href="/dashboard/events/new">
                    <IconPlus className="size-4" />
                    Create event
                  </Link>
                </Button>
              )
            }
          />
        )}

        {stepsLeft > 0 ? (
          <Panel title="Getting set up" hint={`${steps.length - stepsLeft} of ${steps.length}`}>
            <ul className="flex flex-col">
              {steps.map((step) => (
                <li key={step.key}>
                  <Link
                    href={step.href}
                    className={cn(
                      "flex min-h-11 items-center gap-2.5 rounded-md text-[0.84375rem] transition-colors hover:text-foreground",
                      step.done ? "text-muted-foreground" : "text-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-[18px] shrink-0 items-center justify-center rounded-full",
                        step.done ? "bg-success" : "border-[1.5px] border-border-strong"
                      )}
                    >
                      {step.done ? <IconCheck aria-hidden className="size-3 text-brand-ink" /> : null}
                    </span>
                    <span className={cn("flex-1", step.done && "line-through")}>
                      {step.label}
                      <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
                    </span>
                    {step.done ? null : (
                      <IconChevronRight aria-hidden className="size-3.5 text-faint-foreground" />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>

      {/*
        Pacing against the last event that ran — kept from the previous overview
        though the kit moves it: it is a free figure (the pricing audit's
        "pacing vs last event"), and this is the only place it is drawn.
      */}
      {nextEvent ? (
        <Panel>
          <PacingChart
            points={data.pacing}
            capacity={data.pacingCapacity}
            benchmark={data.benchmark}
            windowDays={data.pacing.length ? data.pacing[0].daysOut : 21}
            empty={data.pacing.every((p) => p.cumulative === 0)}
          />
        </Panel>
      ) : null}

      <section className="flex flex-col gap-2.5" aria-labelledby="last-30-days">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 id="last-30-days" className="text-panel-title font-bold">
            Last 30 days
          </h2>
          <span className="text-[0.75rem] text-faint-foreground">
            {formatNumber(data.checkIns.current)} check-in{data.checkIns.current === 1 ? "" : "s"} · ratings and
            came back count every event
          </span>
        </div>
        <KpiStrip
          items={[
            {
              label: "Check-ins",
              value: formatNumber(data.checkIns.current),
              ...withHint(tileDelta(data.checkIns), "vs the 30 days before"),
            },
            {
              label: "No-show rate",
              value: data.noShowRatePct === null ? null : formatPct(data.noShowRatePct),
              // A change in a rate is in points: 30% → 36% is +6 pts, not +6%.
              delta: data.noShowDelta ?? undefined,
              deltaInvert: true,
              deltaSuffix: "pts",
              hint: data.noShowRatePct === null ? "needs a past event" : "RSVP'd, didn't come",
              href: "/dashboard/attendees",
            },
            {
              label: "Avg rating",
              value: data.averageRating,
              hint:
                data.ratingCount === 0
                  ? "no ratings yet"
                  : data.averageRating === null
                    ? "not enough ratings yet"
                    : `${formatNumber(data.ratingCount)} ratings`,
            },
            {
              label: "Came back",
              value: data.repeatAttendees,
              hint: "for a 2nd event",
              href: "/dashboard/attendees",
            },
          ]}
        />
      </section>

      <div className="grid items-start gap-5 @3xl/main:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Panel
          title="Coming up"
          action={
            <Link
              href="/dashboard/events"
              className="text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground pointer-coarse:py-3"
            >
              All events
            </Link>
          }
          bodyClassName="p-0 pt-3"
        >
          {data.comingUp.length ? (
            <div className="@container/rows">
              {data.comingUp.map((row) => (
                <EventRow key={row.id} row={row} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 border-t border-border px-5 py-5">
              <p className="text-[0.84375rem] text-muted-foreground">
                Nothing scheduled. Events you publish or draft appear here, soonest first.
              </p>
              {createAction ?? (
                <Button asChild size="sm" variant="outline">
                  <Link href="/dashboard/events/new">Create event</Link>
                </Button>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Latest feedback" hint={data.latestFeedback?.title}>
          {data.latestFeedback ? (
            <>
              <RatingBars counts={data.latestFeedback.ratings} />
              <Link
                href={`/dashboard/events/${data.latestFeedback.eventId}/feedback`}
                className="inline-flex w-fit items-center gap-1 text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground pointer-coarse:py-3"
              >
                What people said
                <IconArrowRight aria-hidden className="size-3.5" />
              </Link>
            </>
          ) : (
            <p className="text-[0.84375rem] text-muted-foreground">
              An event&apos;s ratings show here once five people have rated it. Fewer would let each rater work out
              another&apos;s score.
            </p>
          )}
        </Panel>
      </div>
    </div>
  )
}

/**
 * The night that is running now. A red-edged strip, the only one on the page,
 * there only while it runs; the flagged-message count is the one red sentence.
 */
function LiveBanner({ live }: { live: LiveEvent }) {
  return (
    <section
      aria-label={`${live.title} is live`}
      className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-panel border border-destructive/40 bg-destructive/[0.06] px-5 py-4"
    >
      <LiveDot />
      <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="text-sm font-bold">{live.title} is live</span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {[live.venue, `doors ${live.doors}`].filter(Boolean).join(" · ")}
          {live.flags > 0 ? (
            <>
              {" · "}
              <b className="font-bold text-destructive">
                {live.flags} flagged message{live.flags === 1 ? "" : "s"} need{live.flags === 1 ? "s" : ""} you
              </b>
            </>
          ) : null}
        </span>
      </span>
      <dl className="flex gap-7">
        {(
          [
            [live.inside, "in the room"],
            [live.checkedIn, "checked in"],
            [live.messages, "messages"],
          ] as const
        ).map(([value, label]) => (
          <div key={label} className="flex flex-col-reverse">
            <dt className="text-[0.75rem] text-faint-foreground">{label}</dt>
            <dd className="text-[1.375rem] font-bold leading-[1.1] tabular-nums">{formatNumber(value)}</dd>
          </div>
        ))}
      </dl>
      <Button asChild className="pointer-coarse:h-11">
        <Link href={`/dashboard/events/${live.id}?tab=live`}>
          Open live view
          <IconArrowRight aria-hidden className="size-4" />
        </Link>
      </Button>
    </section>
  )
}

/** A tile's own hint unless the delta brought one ("new"). */
function withHint(delta: { delta?: number; hint?: string }, fallback: string) {
  return { ...delta, hint: delta.hint ?? fallback }
}

const daysToGo = (days: number) =>
  days === 0 ? "today" : days === 1 ? "1 day to go" : `${days} days to go`
