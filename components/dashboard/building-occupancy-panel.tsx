import Link from "next/link"

import { LiveDot } from "@/components/dashboard/kit"
import type { BuildingOccupancy } from "@/lib/building-occupancy"
import { liveCountLabel } from "@/lib/disclosure"
import { cn } from "@/lib/utils"

/**
 * How many people are in the building, and which room they are in (the kit's
 * `Building`, `venue-sponsor.jsx`).
 *
 * The venue owner's question, which the per-event occupancy figure cannot
 * answer: two events running at once are two correct numbers and no total.
 *
 * Counts bodies rather than guests — a fire safety number counts people, not
 * job titles — while the per-room rows keep the split, so an owner can still see
 * that the basement is thirty guests and four crew. The venue's own live room
 * (people who went live here, not at an event) is a room too, and for its owner
 * a range like every room they do not run (SCRUM-516).
 *
 * Silent when nothing is running. A venue with no live event is not a venue with
 * a problem, and a zero here every afternoon would train someone to ignore the
 * panel by the time it matters.
 *
 * The fill bar is the screen's one gradient element (DESIGN_SYSTEM.md).
 */
export function BuildingOccupancyPanel({
  occupancy,
  venueName,
}: {
  occupancy: BuildingOccupancy
  /** Named on the overview, where an owner may have several buildings; not on the venue's own page. */
  venueName?: string
}) {
  if (occupancy.rooms.length === 0) return null

  const { inside, capacity, fillPct, overCapacity, rooms } = occupancy
  // Rooms another host runs read as ranges for the owner (SCRUM-516).
  const ranged = rooms.some((r) => typeof r.inside === "string")

  return (
    <section
      aria-label={venueName ? `In the building at ${venueName}` : "In the building"}
      className={cn(
        "flex min-w-0 flex-col rounded-panel border bg-card px-5 py-4",
        overCapacity ? "border-[color-mix(in_oklch,var(--primary)_55%,transparent)]" : "border-border"
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <LiveDot />
        <p className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          In the building{venueName ? ` · ${venueName}` : ""} · right now
        </p>
        {/* Only when there is more than one, or it reads as a stat about a
            single event that already has its own screen. */}
        {rooms.length > 1 ? (
          <span className="text-[0.75rem] text-faint-foreground">{rooms.length} rooms running</span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        {inside !== null ? (
          <span className="text-[2.5rem] font-bold leading-[1.05] tabular-nums">{liveCountLabel(inside)}</span>
        ) : null}
        <span className="text-[0.9375rem] text-muted-foreground">
          {inside === null
            ? `no total: rooms you don't run are shown as ranges${capacity === null ? "" : ` · ${capacity} licensed`}`
            : capacity === null
              ? "people, no licensed capacity on file"
              : `of ${capacity} licensed`}
        </span>
        {overCapacity && capacity !== null ? (
          /* Ink on orange, never white — 3.4:1 fails AA. */
          <span className="rounded-full bg-primary px-2.5 py-0.5 text-[0.8125rem] font-bold tabular-nums text-primary-foreground">
            {typeof inside === "number" ? `${inside - capacity} over` : "over licence"}
          </span>
        ) : null}
        {fillPct !== null && !overCapacity ? (
          <span className="text-[0.75rem] tabular-nums text-faint-foreground">{fillPct}% full</span>
        ) : null}
      </div>

      {fillPct !== null ? (
        <div
          role="presentation"
          className="mt-3 h-2 overflow-hidden rounded-full bg-surface-raised"
        >
          <div
            className="h-full rounded-full bg-[image:var(--gradient-brand)]"
            style={{ width: `${Math.min(fillPct, 100)}%` }}
          />
        </div>
      ) : null}

      <ul className="mt-3.5 flex flex-col gap-1.5">
        {rooms.map((room) => (
          <li key={room.eventId} className="flex items-baseline justify-between gap-4 text-[0.84375rem]">
            <Link
              href={`/dashboard/events/${room.eventId}?tab=live`}
              className="min-w-0 truncate text-foreground underline-offset-4 hover:underline"
            >
              {room.title}
            </Link>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <b className="font-bold text-foreground">{liveCountLabel(room.inside)}</b>
              {/* The split only when there is one to show — see the note in
                  occupancy-hero.tsx. */}
              {room.staffInside ? ` — ${room.guestsInside} guests, ${room.staffInside} staff` : null}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2.5 text-[0.71875rem] text-faint-foreground">
        Everyone checked in and not yet out, staff included. Measured against the
        venue&rsquo;s own capacity rather than the sum of the events&rsquo; — two rooms can each
        be under their number while the building is over its.
        {ranged ? " Rooms you don't run are shown as ranges, so one arrival does not show." : ""}
      </p>
    </section>
  )
}
