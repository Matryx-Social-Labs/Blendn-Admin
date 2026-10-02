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
import {
  occupancyMostlyInferred,
  type LiveAlert,
  type LiveSnapshot,
  type VenueLiveSnapshot,
} from "@/lib/live-metrics"
import type { IssueRow } from "@/lib/event-issues"
import { earlierIssues } from "@/lib/issue-timestamp"
import { IssueLog } from "@/components/dashboard/issue-log"
import { useOpsSnapshot } from "@/lib/use-ops-snapshot"
import { formatNumber, formatPct } from "@/lib/dashboard-format"
import { liveCountLabel } from "@/lib/disclosure"
import { cn } from "@/lib/utils"
import { eventClock, livePhaseFor } from "@/lib/event-phase"

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
 * Everything here comes from `event:{id}:ops` (or `:ops:venue`, the ranged
 * copy a venue is sent), which carries aggregates only — no attendee row, id or
 * name crosses that channel, so pseudonymity holds on the wire and not merely
 * in the REST payload.
 */
export function LiveTab({
  eventId,
  startAt,
  endAt,
  timezone,
  issues = [],
}: {
  eventId: string
  startAt: string
  endAt: string
  /** The event's own zone: its times are told in it, not the viewer's (SCRUM-421). */
  timezone: string
  /**
   * What has already happened tonight, from `event_issues`.
   *
   * The alerts below are derived live from the socket snapshot and vanish with
   * the tab. These persist, which is the whole point: an over-capacity breach
   * at 23:40 used to be gone at 23:45 unless somebody was looking at it.
   */
  issues?: IssueRow[]
}) {
  const phase = livePhaseFor(startAt, endAt)
  const clock = eventClock(timezone)
  // Only hold a socket while there is something to watch. The server runs its
  // snapshot timer per event while anyone is subscribed, so connecting outside
  // the live window would keep it querying for a screen showing an empty state.
  const { snapshot, status } = useOpsSnapshot(eventId, phase === "live")

  // Derived on the server, on the exact figures -- a venue's ranges could not
  // be thresholded -- and sent with the snapshot (SCRUM-516).
  const alerts = useMemo(() => snapshot?.alerts ?? [], [snapshot])

  // The log drops whatever Alerts is already showing — see `earlierIssues`.
  const earlier = useMemo(
    () => earlierIssues(issues, alerts.map((a) => a.kind)),
    [issues, alerts]
  )

  const arrival: ArrivalPoint[] = useMemo(() => {
    if (!snapshot || snapshot.view === "venue") return []
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

  /*
   * Two copies of one screen. Whoever runs the event (or an admin) gets the
   * figures; the venue it is held at, watching a night it does not run or its
   * own venue day, gets ranges -- and no curve, fill or ratio, each of which
   * would hand the count back (SCRUM-516).
   */
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 @3xl/main:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-4">
          <OccupancyHero
            occupancy={snapshot}
            unreliable={snapshot.view === "host" ? occupancyMostlyInferred(snapshot) : snapshot.mostlyInferred}
            time={clock.time(new Date(snapshot.at))}
            description={snapshot.view === "host" ? hostDescription(snapshot) : venueDescription(snapshot)}
          />

          <div className="flex flex-wrap gap-1">
            <MetricTile
              label="Check-in rate"
              value={liveCountLabel(snapshot.checkInRate10m)}
              hint={
                snapshot.view === "host" && snapshot.medianRate10m > 0
                  ? `per 10 min · ×${(snapshot.checkInRate10m / snapshot.medianRate10m).toFixed(1)} median`
                  : "per 10 min"
              }
            />
            <MetricTile
              label="Checked out"
              value={liveCountLabel(snapshot.checkedOutTotal)}
              hint="before scheduled end"
            />
            <MetricTile label="Msgs/min" value={snapshot.messagesPerMinute} />
            <MetricTile
              label="Active chatters"
              value={liveCountLabel(snapshot.activeChatters30m)}
              hint="distinct, last 30 min"
            />
            <MetricTile label="Open flags" value={snapshot.openFlags} />
          </div>

          {snapshot.view === "host" ? (
            <ArrivalCurve
              data={arrival}
              capacity={snapshot.capacity}
              doorsLabel={clock.time(new Date(startAt))}
              endLabel={clock.time(new Date(endAt))}
              empty={snapshot.checkedInTotal === 0}
            />
          ) : null}
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

          {/*
            The same rules, recorded. Everything above is derived from the live
            snapshot and disappears with the tab; this is what a server sweep
            wrote down while nobody was looking — the only version that can
            answer "did anything go wrong" the morning after.

            "Tonight's" was wrong twice over: `issuesFor` is not scoped to
            tonight — it returns the event's whole history — and a run can span
            days, so on staging this heading sat above an issue from six days
            earlier. "Earlier" is what the list is once the duplicates below are
            removed, and it is true for a one-night event and a month-long one
            alike.
          */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold">Earlier</h3>
            <IssueLog issues={earlier} timezone={timezone} />
          </div>

          {snapshot.view === "host" ? (
            <>
              <SentimentBar snapshot={snapshot} />
              <CategoryBars
                title="Complaints — last 30 min"
                hint="negative + safety messages"
                data={snapshot.categories}
                empty={snapshot.categories.length === 0}
                emptyText="Nothing negative classified yet in this window."
              />
            </>
          ) : (
            <VenueMood snapshot={snapshot} />
          )}
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

function hostDescription(s: LiveSnapshot): string {
  return `${formatNumber(s.checkedInTotal)} checked in, ${formatNumber(s.checkedOutTotal)} left${
    s.staleInside > 0
      ? `. ${formatNumber(s.staleInside)} not seen in the last few minutes — phones sleep, so they are still counted`
      : ""
  }${
    s.medianRate10m > 0
      ? `. Arrival rate ${s.checkInRate10m}/10min — ×${(s.checkInRate10m / s.medianRate10m).toFixed(1)} tonight's median.`
      : "."
  }`
}

function venueDescription(s: VenueLiveSnapshot): string {
  return `${liveCountLabel(s.checkedInTotal)} checked in, ${liveCountLabel(s.checkedOutTotal)} left${
    // "Under 5" here could be nobody: said only when it is some.
    s.staleInside !== "quiet"
      ? `. ${liveCountLabel(s.staleInside)} not seen in the last few minutes — phones sleep, so they are still counted`
      : ""
  }. Shown as ranges, so one person arriving or leaving does not show.`
}

/** The mood and the complaints as ranges: bars would draw the counts back. */
function VenueMood({ snapshot }: { snapshot: VenueLiveSnapshot }) {
  const { positive, neutral, negative } = snapshot.sentiment
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-bold">Mood — last 30 min</h3>
      <p className="text-[0.78rem] text-muted-foreground">
        {liveCountLabel(positive)} positive · {liveCountLabel(neutral)} neutral · {liveCountLabel(negative)} negative
      </p>
      <h3 className="mt-2 text-sm font-bold">Complaints — last 30 min</h3>
      {snapshot.categories.length === 0 ? (
        <p className="text-[0.78rem] text-muted-foreground">Nothing negative classified yet in this window.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-[0.78rem] text-muted-foreground">
          {snapshot.categories.map((c) => (
            <li key={c.category} className="flex justify-between gap-3">
              <span>{c.category.replaceAll("_", " ")}</span>
              <b className="font-bold tabular-nums text-foreground">{liveCountLabel(c.count)}</b>
            </li>
          ))}
        </ul>
      )}
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
