import { formatNumber, hereRange } from "@/lib/dashboard-format"
import { liveCountLabel, type LiveCountBucket } from "@/lib/disclosure"
import type { Occupancy } from "@/lib/occupancy"
import { cn } from "@/lib/utils"

/**
 * A room as a venue is shown it while somebody else runs it, or on its venue
 * day: ranges, and the over-capacity flag decided on the exact figures
 * (SCRUM-516). No fill: a percentage of a stated capacity is the count again.
 */
export interface HeldBackOccupancy {
  inside: LiveCountBucket
  guestsInside: LiveCountBucket
  staffInside: LiveCountBucket
  capacity: number | null
  overCapacity: boolean
}

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
 *
 * The host's figure is a range (SCRUM-1328): who was seen within the confirmed
 * window to everyone checked in, because pings are foreground only and a
 * pocketed phone goes quiet. The bar draws both ends, solid then hatched.
 * Capacity, the pill and the fill read the high end, always: they are the
 * safety signal, and a full room is exactly the one whose phones are pocketed.
 * The venue's copy keeps its rounded high end and gets no low end.
 */
export function OccupancyHero({
  occupancy,
  time,
  stale,
  description,
}: {
  /**
   * Only the room, not attendance — `uniqueAttendance` is the Overview's
   * question and demanding it here would force the live snapshot to carry a
   * number nothing on this screen renders.
   */
  occupancy: (Omit<Occupancy, "uniqueAttendance"> & { unconfirmed: number }) | HeldBackOccupancy
  /** Rendered as given — the caller owns the event's timezone, not this. */
  time: string
  /** The connection dropped and these are the last figures: no "· live" (SCRUM-1348). */
  stale?: boolean
  description?: string
}) {
  const { inside, guestsInside, capacity } = occupancy
  // The exact figures, or null for a venue's ranges: no bar, no fill, no "N over".
  const exact = "fillPct" in occupancy ? occupancy : null
  // "Under 5 staff" could be none, and usually is: shown from 5 up.
  const anyStaff = exact ? exact.staffInside > 0 : occupancy.staffInside !== "quiet"
  const over = occupancy.overCapacity
  const overBy = over && exact && capacity !== null ? exact.guestsInside - capacity : 0
  const range = exact ? hereRange(exact.inside, exact.unconfirmed) : null
  const count = (n: number | LiveCountBucket) => (typeof n === "number" ? formatNumber(n) : liveCountLabel(n))

  // The bar's domain stretches past capacity when the room is over it, so the
  // dashed capacity marker lands inside the track rather than at its very end.
  const guests = exact?.guestsInside ?? 0
  // Seen guests, at most: `unconfirmed` counts staff too, so the solid part never claims more guests than there are.
  const seen = exact ? Math.min(guests, Math.max(0, exact.inside - exact.unconfirmed)) : 0
  const domain = capacity === null ? Math.max(guests, 1) : Math.max(capacity, guests)
  const guestPct = Math.min((guests / domain) * 100, 100)
  const seenPct = Math.min((seen / domain) * 100, guestPct)
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

      <p className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        In the room · {time}
        {stale ? null : " · live"}
      </p>

      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        {range ? (
          <>
            {/* Said once, in words and full numbers; the glyphs ("9.9k–12k") are for the eye. Not a live region: a range read out every five seconds would drown the tab. */}
            <span className="sr-only">{range.spoken}</span>
            <span aria-hidden="true" className="text-[length:var(--text-metric-hero)] font-bold leading-[1.05] tabular-nums">
              {range.label}
            </span>
            <span aria-hidden="true" className="text-base text-muted-foreground">here</span>
          </>
        ) : (
          <>
            <span className="text-[length:var(--text-metric-hero)] font-bold leading-[1.05] tabular-nums">
              {liveCountLabel(inside)}
            </span>
            <span className="text-base text-muted-foreground">in the room</span>
          </>
        )}
        {over ? (
          /* Ink on orange, never white — white on #F05423 is 3.4:1 and fails AA. */
          <span className="rounded-full bg-primary px-2.5 py-0.5 text-[0.8125rem] font-bold tabular-nums text-primary-foreground">
            {exact ? `${formatNumber(overBy)} over stated capacity` : "over stated capacity"}
          </span>
        ) : null}
      </div>

      {/* The split. Two numbers with their own labels — never one figure. */}
      <div className="mt-2 flex flex-wrap gap-4 text-[0.8438rem] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2 rounded-[2px] bg-chart-1" />
          <b className="font-bold tabular-nums text-foreground">{count(guestsInside)}</b> guests
        </span>
        {/* Only when there are any.
            Staff are told from guests by organisation membership at check-in,
            which costs nothing and needs no client change — but it only fires if
            an org member checks in through the attendee app, and there is no
            plan for crew to have accounts there. In practice this is zero, and
            "0 staff" beside a real number is noise pretending to be a reading. */}
        {anyStaff ? (
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="size-2 rounded-[2px] bg-chart-3" />
            <b className="font-bold tabular-nums text-foreground">{count(occupancy.staffInside)}</b> staff
          </span>
        ) : null}
      </div>

      {!exact && capacity !== null ? (
        <p className="mt-3 text-[0.75rem] tabular-nums text-faint-foreground">
          of capacity {capacity}
        </p>
      ) : null}

      {exact && capacity !== null ? (
        <div className="mt-3 flex flex-col gap-1">
          <div
            role="progressbar"
            aria-valuenow={exact.fillPct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Fill: ${formatNumber(guests)} guests of capacity ${formatNumber(capacity)}`}
            className="relative h-2 rounded-full bg-surface-raised"
          >
            {/* Solid to the guests seen, hatched (the kit's) on to everyone checked in. */}
            <div
              className="absolute inset-y-0 rounded-full"
              style={{ left: 0, width: `${seenPct}%`, background: over ? "var(--primary)" : "var(--gradient-brand)" }}
            />
            <div
              className="absolute inset-y-0 rounded-full"
              style={{
                left: `${seenPct}%`,
                width: `${guestPct - seenPct}%`,
                background:
                  "repeating-linear-gradient(45deg, color-mix(in oklch, var(--primary) 40%, transparent) 0 5px, transparent 5px 10px)",
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
                  {formatNumber(guests)} guests against capacity {formatNumber(capacity)}
                </b>{" "}
                — fill {exact.fillPct}%. Staff aren&rsquo;t counted toward fill.
              </>
            ) : (
              <>
                fill {exact.fillPct}% — {formatNumber(guests)} guests of capacity {formatNumber(capacity)}; staff count toward the room, not the fill
              </>
            )}
          </p>
        </div>
      ) : null}

      {description ? (
        <p className="mt-3 max-w-[58ch] text-sm leading-6 text-muted-foreground">{description}</p>
      ) : null}
    </section>
  )
}
