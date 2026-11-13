import Link from "next/link"

import { Panel } from "@/components/dashboard/kit"
import { MetricTile } from "@/components/dashboard/primitives"
import { RefreshEvery } from "@/components/dashboard/refresh-every"
import type { VenueTonight } from "@/lib/venue-room-tonight"

/** Once a minute, as the host's "Meeting tonight" (`HELD_SOCIAL_MS`): the figures are ranges and move at their edges only. */
const REFRESH_MS = 60_000

const HOSTS = "host’s"

/**
 * "Tonight at <venue>" (Venue C, SCRUM-1051, mockup `venue-C-both.png`): is the
 * venue busy and is the room OK, without opening the event. Ranges and words
 * only; met someone and crews only on the venue's own venue day, "host's" on a
 * night another host runs. Silent when nothing runs, like the building panel.
 */
export function VenueTonightPanel({ tonight, venueName }: { tonight: VenueTonight | null; venueName: string }) {
  if (!tonight) return null
  const { met, crews } = tonight
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {/* Ink on orange, never white (3.4:1 fails AA), as the building panel's "over". */}
          <span className="rounded-md bg-primary px-[7px] py-0.5 text-[0.6875rem] font-bold tracking-[0.05em] text-primary-foreground">
            LIVE
          </span>
          <Link href={`/dashboard/events/${tonight.eventId}?tab=live`} className="whitespace-normal underline-offset-4 hover:underline">
            Tonight at {venueName} · {tonight.label}
          </Link>
        </span>
      }
      // Beside the title where there is room; on a phone the title needs the line, and the note below says the same.
      action={<span className="hidden shrink-0 text-[0.75rem] text-faint-foreground @2xl/main:inline">ranges, never exact · every minute</span>}
      bodyClassName="gap-3 pt-3"
    >
      <RefreshEvery ms={REFRESH_MS} />
      <div className="grid grid-cols-2 gap-x-8 gap-y-2 @2xl/main:grid-cols-3 @5xl/main:flex @5xl/main:flex-wrap @5xl/main:gap-x-10">
        <MetricTile className="min-w-0 px-0 py-1.5" label="In the room" value={tonight.inRoom} hint="guests" />
        <MetricTile className="min-w-0 px-0 py-1.5" label="Arriving" value={tonight.arriving} hint="per 10 min" />
        <MetricTile className="min-w-0 px-0 py-1.5" label="Mood" value={tonight.mood} hint="last 30 min" />
        <MetricTile
          className="min-w-0 px-0 py-1.5"
          label="Met someone"
          value={met === "hosts" ? HOSTS : met}
          hint={met === "hosts" ? "not yours to see" : met === "held" ? "until 8 guests" : "your room only"}
        />
        <MetricTile
          className="min-w-0 px-0 py-1.5"
          label="Crews here"
          value={crews === "hosts" ? HOSTS : crews}
          hint={crews === null ? "between days" : crews === "hosts" ? "not yours to see" : undefined}
        />
        {tonight.offers !== null ? (
          <MetricTile className="min-w-0 px-0 py-1.5" label="Offers redeemed" value={tonight.offers} hint="tonight" />
        ) : null}
      </div>
      <p className="text-[0.75rem] text-faint-foreground">
        <span className="@2xl/main:hidden">Ranges, never exact; every minute. </span>
        On another host&rsquo;s night here you see the room and the mood; how people met stays the host&rsquo;s.
      </p>
    </Panel>
  )
}
