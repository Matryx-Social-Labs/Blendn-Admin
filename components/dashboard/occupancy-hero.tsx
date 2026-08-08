import { IconWifiOff } from "@tabler/icons-react"
import type { ReactNode } from "react"

import type { Occupancy } from "@/lib/occupancy"
import { cn } from "@/lib/utils"

/**
 * Who is in the room, right now.
 *
 * Three numbers that used to be one, and conflating them is what caused the bug
 * this screen came from:
 *
 *   capacity     what the room holds
 *   occupancy    bodies in it now — staff included, because fire safety counts
 *                bodies rather than job titles
 *   attendance   who came at all, which lives in its own panel
 *
 * So the guest/staff split is always on screen and never folded into the
 * headline. "142 in the room — 138 guests, 4 staff" answers two questions the
 * same person asks ten seconds apart; one number answers neither.
 *
 * Over capacity is a **signal, not an error**. Check-in stopped refusing at the
 * line because the geofence covers the queue outside, so the room being fuller
 * than planned is now observable for the first time — and it is precisely the
 * crowd-safety moment this product is positioned around. Nothing is broken, so
 * it must not read as a malfunction, and it must be impossible to miss.
 *
 * Fill is measured against **guests**, so four crew do not fill a room of four.
 */
export function OccupancyHero({
  occupancy,
  time,
  unreliable,
  lastGood,
  description,
  action,
}: {
  /**
   * Only the room, not attendance — `uniqueAttendance` is the Overview's
   * question and demanding it here would force the live snapshot to carry a
   * number nothing on this screen renders.
   */
  occupancy: Omit<Occupancy, "uniqueAttendance">
  /** Rendered as given — the caller owns the event's timezone, not this. */
  time: string
  /**
   * The presence sweeper refused to act because one pass would have checked out
   * more than a quarter of the room. A venue whose wifi dies produces readings
   * identical to everyone leaving at once, and the organiser is far better
   * served by "this count is unreliable" than by a confidently wrong number.
   */
  unreliable?: boolean
  lastGood?: string
  description?: string
  action?: ReactNode
}) {
  const { inside, guestsInside, staffInside, capacity, fillPct } = occupancy
  // Suppressed while unreliable: flagging a breach off numbers we have just
  // said we do not trust is how a false evacuation starts.
  const over = occupancy.overCapacity && !unreliable
  const overBy = over && capacity !== null ? guestsInside - capacity : 0

  // The bar's domain stretches past capacity when the room is over it, so the
  // dashed capacity marker lands inside the track rather than at its very end.
  const domain = capacity === null ? Math.max(guestsInside, 1) : Math.max(capacity, guestsInside)
  const guestPct = Math.min((guestsInside / domain) * 100, 100)
  const capacityPct = capacity === null ? null : (capacity / domain) * 100

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-lg border bg-card px-5 py-5",
        over ? "border-[color-mix(in_oklch,var(--primary)_55%,transparent)]" : "border-border"
      )}
    >
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: "var(--gradient-brand)" }}
      />

      <div className="flex flex-wrap items-center gap-2.5">
        <p className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          In the room · {time} · live
        </p>
        {unreliable ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning bg-[color-mix(in_oklch,var(--warning)_8%,transparent)] px-2.5 py-0.5 text-[0.7188rem] font-bold text-warning">
            <IconWifiOff className="size-3" />
            count unreliable
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        <span
          className={cn(
            "text-[length:var(--text-metric-hero)] font-bold leading-[1.05] tabular-nums",
            unreliable && "text-muted-foreground"
          )}
        >
          {unreliable ? "~" : ""}
          {inside}
        </span>
        <span className="text-base text-muted-foreground">
          {unreliable ? "in the room, roughly" : "in the room"}
        </span>
        {over ? (
          /* Ink on orange, never white — white on #F05423 is 3.4:1 and fails AA. */
          <span className="rounded-full bg-primary px-2.5 py-0.5 text-[0.8125rem] font-bold tabular-nums text-[#0D0C0C]">
            {overBy} over stated capacity
          </span>
        ) : null}
      </div>

      {/* The split. Two numbers with their own labels — never one figure. */}
      <div
        className={cn(
          "mt-2 flex flex-wrap gap-4 text-[0.8438rem] text-muted-foreground",
          unreliable && "opacity-75"
        )}
      >
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2 rounded-[2px] bg-chart-1" />
          <b className="font-bold tabular-nums text-foreground">{guestsInside}</b> guests
        </span>
        {/* Only when there are any.
            Staff are told from guests by organisation membership at check-in,
            which costs nothing and needs no client change — but it only fires if
            an org member checks in through the attendee app, and there is no
            plan for crew to have accounts there. In practice this is zero, and
            "0 staff" beside a real number is noise pretending to be a reading. */}
        {staffInside > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="size-2 rounded-[2px] bg-chart-3" />
            <b className="font-bold tabular-nums text-foreground">{staffInside}</b> staff
          </span>
        ) : null}
        {unreliable && lastGood ? (
          <span className="text-[0.75rem] text-faint-foreground">as of {lastGood}</span>
        ) : null}
      </div>

      {capacity !== null ? (
        <div className="mt-3 flex flex-col gap-1">
          <div
            role="progressbar"
            aria-valuenow={fillPct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Fill: ${guestsInside} guests of capacity ${capacity}`}
            className="relative h-2 rounded-full bg-surface-raised"
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: `${guestPct}%`,
                background: unreliable
                  ? "repeating-linear-gradient(45deg, color-mix(in oklch, var(--primary) 40%, transparent) 0 5px, transparent 5px 10px)"
                  : over
                    ? "var(--primary)"
                    : "var(--gradient-brand)",
              }}
            />
            {over && capacityPct !== null ? (
              <div
                aria-hidden
                className="absolute -top-1 -bottom-1 w-0 border-l-2 border-dashed border-foreground"
                style={{ left: `${capacityPct}%` }}
              />
            ) : null}
          </div>
          <p
            className={cn(
              "text-[0.75rem] tabular-nums",
              over ? "text-foreground" : "text-faint-foreground"
            )}
          >
            {over ? (
              <>
                <b className="font-bold">
                  {guestsInside} guests against capacity {capacity}
                </b>{" "}
                — fill {fillPct}%. Staff aren&rsquo;t counted toward fill.
              </>
            ) : (
              <>
                fill {unreliable ? "~" : ""}
                {fillPct}% — {guestsInside} guests of capacity {capacity}; staff count toward the
                room, not the fill
              </>
            )}
          </p>
        </div>
      ) : null}

      {description ? (
        <p className="mt-3 max-w-[58ch] text-sm leading-6 text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </section>
  )
}
