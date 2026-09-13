import Link from "next/link"

import type { BuildingOccupancy } from "@/lib/building-occupancy"
import { cn } from "@/lib/utils"

/**
 * How many people are in the building, and which room they are in.
 *
 * The venue owner's question, which the per-event occupancy figure cannot
 * answer: two events running at once are two correct numbers and no total.
 *
 * Counts bodies rather than guests — a fire safety number counts people, not
 * job titles — while the per-room rows keep the split, so an owner can still see
 * that the basement is thirty guests and four crew.
 *
 * Silent when nothing is running. A venue with no live event is not a venue with
 * a problem, and a zero here every afternoon would train someone to ignore the
 * panel by the time it matters.
 */
export function BuildingOccupancyPanel({ occupancy }: { occupancy: BuildingOccupancy }) {
  if (occupancy.rooms.length === 0) return null

  const { inside, capacity, fillPct, overCapacity, rooms } = occupancy

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-lg border bg-card px-5 py-4",
        overCapacity ? "border-[color-mix(in_oklch,var(--primary)_55%,transparent)]" : "border-border"
      )}
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          In the building
        </p>
        {/* Only when there is more than one, or it reads as a stat about a
            single event that already has its own screen. */}
        {rooms.length > 1 ? (
          <span className="text-[0.75rem] text-faint-foreground">
            {rooms.length} events running
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-3">
        <span className="text-[1.625rem] font-bold leading-[1.1] tabular-nums">{inside}</span>
        <span className="text-sm text-muted-foreground">
          {capacity === null
            ? "people, no licensed capacity on file"
            : `of ${capacity} licensed`}
        </span>
        {overCapacity && capacity !== null ? (
          /* Ink on orange, never white — 3.4:1 fails AA. */
          <span className="rounded-full bg-primary px-2.5 py-0.5 text-[0.8125rem] font-bold tabular-nums text-primary-foreground">
            {inside - capacity} over
          </span>
        ) : null}
        {fillPct !== null && !overCapacity ? (
          <span className="text-[0.75rem] tabular-nums text-faint-foreground">{fillPct}% full</span>
        ) : null}
      </div>

      <ul className="mt-3 flex flex-col gap-1.5">
        {rooms.map((room) => (
          <li key={room.eventId} className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
            <Link
              href={`/dashboard/events/${room.eventId}?tab=live`}
              className="truncate text-foreground underline-offset-4 hover:underline"
            >
              {room.title}
            </Link>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <b className="font-bold text-foreground">{room.inside}</b>
              {/* The split only when there is one to show — see the note in
                  occupancy-hero.tsx. */}
              {room.staffInside > 0 ? ` — ${room.guestsInside} guests, ${room.staffInside} staff` : null}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2.5 text-[0.7188rem] text-faint-foreground">
        Everyone checked in and not yet out, staff included. Measured against the
        venue&rsquo;s own capacity rather than the sum of the events&rsquo; — two rooms can each
        be under their number while the building is over its.
      </p>
    </section>
  )
}
