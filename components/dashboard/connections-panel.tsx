import type { ConnectionMetrics } from "@/lib/connection-metrics"
import { MIN_ATTENDEES } from "@/lib/connection-metrics"

/**
 * Did anyone meet anyone.
 *
 * The outcome the product exists for, and the one an organiser cannot get from
 * attendance or ratings. A full room where nobody connects is a successful party
 * and a failed networking event, and only this panel can tell them apart.
 *
 * Two figures rather than one, because the mean alone hides the shape: ten
 * people making twelve connections each while everyone else makes none averages
 * beautifully and is a bad night.
 */
export function ConnectionsPanel({ metrics }: { metrics: ConnectionMetrics }) {
  const { attendees, connections, connected, perAttendee, connectedPct, suppressed } = metrics

  if (suppressed) {
    return (
      <section className="flex flex-col gap-1.5">
        <h3 className="text-sm font-bold">Connections</h3>
        <p className="max-w-[52ch] text-[0.8125rem] text-muted-foreground">
          {attendees === 0
            ? "Nobody checked in, so there was nobody to meet."
            : `Held back until ${MIN_ATTENDEES} people have attended. With ${attendees}, a count of connections would name the people who made them rather than describe the room.`}
        </p>
      </section>
    )
  }

  const none = connections === 0

  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-sm font-bold">Connections</h3>

      <div className="flex flex-wrap items-baseline gap-3.5">
        <span className="text-[1.625rem] font-bold leading-[1.1] tabular-nums">
          {connections}
          <span className="text-sm font-normal text-muted-foreground">
            {" "}
            {connections === 1 ? "connection" : "connections"}
          </span>
        </span>
        <span className="text-[0.8125rem] tabular-nums text-muted-foreground">
          {perAttendee} per person
        </span>
        <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-[0.75rem] font-medium tabular-nums">
          {connectedPct}% met someone
        </span>
      </div>

      {none ? (
        <p className="max-w-[52ch] text-[0.7812rem] text-muted-foreground">
          {attendees} people came and nobody connected. Worth looking at whether the
          room had anything in common — matching ranks on shared interests, and it
          has nothing to work with when profiles are empty.
        </p>
      ) : (
        <p className="max-w-[52ch] text-[0.7812rem] text-muted-foreground">
          {connected} of {attendees} attendees made at least one.{" "}
          {/* The published benchmark, stated rather than implied — a bare
              percentage means nothing without something to compare it to. */}
          {connectedPct !== null && connectedPct >= 50
            ? "Above the point where a networking format is considered to be working."
            : "Formats are generally considered to be working once that passes 50%."}
        </p>
      )}

      <p className="text-[0.7188rem] text-faint-foreground">
        A connection is mutual — both people said yes. One-sided likes are private
        to whoever sent them and are never counted or shown here.
      </p>
    </section>
  )
}
