"use client"

import { useMemo } from "react"
import {
  IconBroadcast,
  IconBroadcastOff,
  IconDoorEnter,
  IconGauge,
  IconLock,
  IconShieldExclamation,
} from "@tabler/icons-react"

import { ArrivalCurve, CategoryBars, type ArrivalPoint } from "@/components/dashboard/charts"
import { OccupancyHero } from "@/components/dashboard/occupancy-hero"
import { EmptyState, MetricTile } from "@/components/dashboard/primitives"
import { deriveAlerts, type LiveAlert } from "@/lib/live-metrics"
import { useOpsSnapshot } from "@/lib/use-ops-snapshot"
import { formatNumber, formatPct } from "@/lib/dashboard-format"
import { cn } from "@/lib/utils"
import { livePhaseFor } from "@/lib/event-phase"

// Moved to lib/event-phase.ts so a server component can ask the question
// without importing this whole client module. Re-exported because callers
// already import it from here.
export { livePhaseFor, type LivePhase } from "@/lib/event-phase"

function AlertCard({ alert }: { alert: LiveAlert }) {
  const critical = alert.severity === "critical"
  const Icon =
    alert.kind === "safety"
      ? IconShieldExclamation
      : alert.kind === "entry_backing_up"
        ? IconDoorEnter
        : IconGauge

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5"
      style={{
        borderColor: critical ? "var(--destructive)" : "var(--warning)",
        background: `color-mix(in oklab, ${critical ? "var(--destructive)" : "var(--warning)"} 6%, transparent)`,
      }}
    >
      <span
        className="flex items-center gap-2 text-[0.8125rem] font-bold"
        style={{ color: critical ? "var(--destructive)" : "var(--warning)" }}
      >
        <Icon className="size-4 shrink-0" />
        {alert.title}
      </span>
      <span className="text-[0.78rem] leading-relaxed text-muted-foreground">{alert.body}</span>
    </div>
  )
}

/**
 * The event as an operation, while it runs.
 *
 * Everything here comes from `event:{id}:ops`, which carries aggregates only —
 * no attendee row, id or name crosses that channel, so pseudonymity holds on
 * the wire and not merely in the REST payload.
 */
export function LiveTab({
  eventId,
  startAt,
  endAt,
}: {
  eventId: string
  startAt: string
  endAt: string
}) {
  const phase = livePhaseFor(startAt, endAt)
  // Only hold a socket while there is something to watch. The server runs its
  // snapshot timer per event while anyone is subscribed, so connecting outside
  // the live window would keep it querying for a screen showing an empty state.
  const { snapshot, status } = useOpsSnapshot(eventId, phase === "live")

  const alerts = useMemo(
    () =>
      snapshot
        ? deriveAlerts(snapshot, {
            scheduledEnd: new Date(endAt),
            scheduledStart: new Date(startAt),
          })
        : [],
    [snapshot, endAt, startAt]
  )

  const arrival: ArrivalPoint[] = useMemo(() => {
    if (!snapshot) return []
    // One point per snapshot is not a history — the series is rebuilt from the
    // totals the server sends, which is honest about being a current reading
    // rather than pretending to a resolution we do not store.
    return [
      { label: "doors", checkedIn: 0, checkedOut: 0 },
      {
        label: "now",
        checkedIn: snapshot.checkedInTotal,
        checkedOut: snapshot.checkedOutTotal,
      },
    ]
  }, [snapshot])

  if (phase === "pre") {
    return (
      <EmptyState
        icon={<IconBroadcast />}
        title="Live view opens at doors"
        description="From the first GPS check-in this tab shows who is inside against capacity, the arrival curve, chat pace, and alerts that combine both signals — entry backing up, leaving early, safety. Aggregates only; attendees stay pseudonymous here too."
      />
    )
  }

  if (phase === "post") {
    return (
      <EmptyState
        icon={<IconBroadcastOff />}
        title="The event has ended"
        description="Live aggregates stop at the scheduled end. What attendees are saying now lands in Feedback while the chat window is still open."
      />
    )
  }

  if (status === "denied") {
    return (
      <EmptyState
        icon={<IconLock />}
        title="Not authorised to watch this event"
        description="Live operations are available to the organiser, the owner of the venue it is held at, and platform admins."
      />
    )
  }

  if (!snapshot) {
    return (
      <EmptyState
        icon={<IconBroadcast />}
        title={status === "error" ? "Live connection lost" : "Connecting…"}
        description={
          status === "error"
            ? "The live channel dropped. It retries automatically; check-ins and messages are still being recorded either way."
            : "Joining the live channel for this event."
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 @3xl/main:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-4">
          <OccupancyHero
            occupancy={snapshot}
            time={new Date(snapshot.at).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            description={`${formatNumber(snapshot.checkedInTotal)} checked in, ${formatNumber(snapshot.checkedOutTotal)} left${
              snapshot.medianRate10m > 0
                ? `. Arrival rate ${snapshot.checkInRate10m}/10min — ×${(snapshot.checkInRate10m / snapshot.medianRate10m).toFixed(1)} tonight's median.`
                : "."
            }`}
          />

          <div className="flex flex-wrap gap-1">
            <MetricTile
              label="Check-in rate"
              value={snapshot.checkInRate10m}
              hint={
                snapshot.medianRate10m > 0
                  ? `per 10 min · ×${(snapshot.checkInRate10m / snapshot.medianRate10m).toFixed(1)} median`
                  : "per 10 min"
              }
            />
            <MetricTile
              label="Checked out"
              value={snapshot.checkedOutTotal}
              hint="before scheduled end"
            />
            <MetricTile label="Msgs/min" value={snapshot.messagesPerMinute} />
            <MetricTile
              label="Active chatters"
              value={snapshot.activeChatters30m}
              hint="distinct, last 30 min"
            />
            <MetricTile label="Open flags" value={snapshot.openFlags} />
          </div>

          <ArrivalCurve
            data={arrival}
            capacity={snapshot.capacity}
            doorsLabel={new Date(startAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            endLabel={new Date(endAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            empty={snapshot.checkedInTotal === 0}
          />
        </div>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold">Alerts</h3>
            {alerts.length === 0 ? (
              <p className="rounded-md border border-border px-3 py-2.5 text-[0.8125rem] text-muted-foreground">
                Nothing needs attention. Alerts combine chat and check-in signal — neither
                fires on its own.
              </p>
            ) : (
              alerts.map((alert) => <AlertCard key={alert.kind} alert={alert} />)
            )}
          </div>

          <SentimentBar snapshot={snapshot} />

          <CategoryBars
            title="Complaints — last 30 min"
            hint="negative + safety messages"
            data={snapshot.categories}
            empty={snapshot.categories.length === 0}
            emptyText="Nothing negative classified yet in this window."
          />
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-[0.75rem] text-faint-foreground">
        <IconLock className="size-3.5" />
        This channel carries aggregates only — no attendee rows cross it, so pseudonymity holds
        even on the wire.
      </p>
    </div>
  )
}

function SentimentBar({ snapshot }: { snapshot: { sentiment: { positive: number; neutral: number; negative: number } } }) {
  const { positive, neutral, negative } = snapshot.sentiment
  const total = positive + neutral + negative
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold">Mood — last 30 min</h3>
        <span className="text-[0.75rem] text-faint-foreground">
          {total} classified msg{total === 1 ? "" : "s"}
        </span>
      </div>
      {total === 0 ? (
        <p className="text-[0.78rem] text-muted-foreground">
          Nothing classified yet in this window.
        </p>
      ) : (
        <>
          <div className="flex h-3 overflow-hidden rounded-full bg-surface-raised">
            <div className="bg-success" style={{ width: `${pct(positive)}%` }} />
            <div className="bg-border-strong" style={{ width: `${pct(neutral)}%` }} />
            <div className="bg-destructive" style={{ width: `${pct(negative)}%` }} />
          </div>
          <p className="text-[0.78rem] text-muted-foreground">
            {positive} positive · {neutral} neutral · {negative} negative
            {total >= 10 && negative / total >= 0.3 ? (
              <span className={cn(negative / total >= 0.4 && "text-destructive")}>
                {" "}
                — negative share {formatPct((negative / total) * 100)}
                {negative / total >= 0.4 ? ", mood sliding" : ""}
              </span>
            ) : null}
          </p>
        </>
      )}
    </div>
  )
}
