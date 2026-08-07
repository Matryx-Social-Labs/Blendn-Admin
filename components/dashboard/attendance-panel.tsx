"use client"

import { AttendanceDays } from "@/components/dashboard/charts"
import type { EventAttendance } from "@/lib/attendance"
import { cn } from "@/lib/utils"

/**
 * Who came — as distinct from who is in the room, which is `OccupancyHero`.
 *
 * Staff are excluded upstream in `lib/attendance.ts`, because staff are not
 * attendees. The panel says so once at the bottom and never re-litigates it.
 *
 * **Single-day is the common case and gets one honest number.** Most events are
 * one evening, and a five-column chart rendering a single bar is a worse answer
 * than a plain figure. The chart only appears for a run that actually has days
 * to compare.
 *
 * Sits below the Overview's hero metric and must not compete with it — one loud
 * element per screen, and this is not it.
 */

/** Turn-up, with the null case designed: no RSVPs is a walk-in evening, not a
 *  division error. */
function TurnUpChip({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <span className="rounded-full border border-border px-2.5 py-0.5 text-[0.75rem] text-faint-foreground">
        nobody RSVP&rsquo;d — walk-ins only
      </span>
    )
  }
  return (
    <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-[0.75rem] font-medium tabular-nums">
      turn-up {pct}%
    </span>
  )
}

export function AttendancePanel({
  attendance,
  live,
}: {
  attendance: EventAttendance
  /** Mid-event: totals are still moving, so turn-up is not a verdict yet. */
  live?: boolean
}) {
  const { uniqueTotal, going, turnUpPct, singleDay, days, retentionPct } = attendance
  const nobody = uniqueTotal === 0

  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-sm font-bold">Attendance</h3>

      <div className="flex flex-wrap items-baseline gap-3.5">
        <span
          className={cn(
            "text-[1.625rem] font-bold leading-[1.1] tabular-nums",
            nobody && "text-muted-foreground"
          )}
        >
          {uniqueTotal}
          <span className="text-sm font-normal text-muted-foreground">
            {" "}
            {live ? "came so far" : "came"}
          </span>
        </span>
        {going > 0 ? (
          <span className="text-[0.8125rem] tabular-nums text-muted-foreground">
            {going} said they would
          </span>
        ) : null}
        {live ? (
          <span className="text-[0.75rem] text-faint-foreground">turn-up settles at close</span>
        ) : (
          <TurnUpChip pct={turnUpPct} />
        )}
      </div>

      {/* Empty is the common case across this product, and an event nobody came
          to should look deliberate rather than broken — so it says which of the
          two problems it is. */}
      {nobody && !live ? (
        <p className="max-w-[52ch] text-[0.7812rem] text-muted-foreground">
          {going > 0
            ? `${going} RSVP'd and nobody checked in — announcement timing and the pacing curve are the first places to look.`
            : "No RSVPs and no check-ins. That's a listing problem, not a check-in problem."}
        </p>
      ) : null}

      {!singleDay ? <AttendanceDays days={days} retentionPct={retentionPct} /> : null}

      <p className="text-[0.7188rem] text-faint-foreground">
        Distinct guests
        {singleDay ? "" : " — a person counts once however many days they came"}. Staff aren&rsquo;t
        attendees and aren&rsquo;t counted here; the live room count includes them.
      </p>
    </section>
  )
}
