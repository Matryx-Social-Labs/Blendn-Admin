import { redirect } from "next/navigation"

import { EventHeader } from "@/components/dashboard/event-header"
import { Panel } from "@/components/dashboard/kit"
import { eventTitleFor } from "@/lib/dashboard-record-titles"
import { eventClock } from "@/lib/event-phase"
import { loadEventPage } from "@/lib/event-page"
import { doorCount } from "@/lib/ticket-door"

import { eventTabsFor } from "../event-tabs"
import { readDoor } from "./actions"
import { DoorClient } from "./door-client"
import { DoorTab } from "./door-tab"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const name = await eventTitleFor((await params).id)
  return { title: name ? `Door · ${name}` : "Door" }
}

/**
 * Door (gate 13; design/02a host B): the event's door code for whoever
 * operates it (`canOperate`: its organization, the venue it is held at, an
 * admin), from doors to the end. The tab never draws the code; "Show the door
 * code" opens it full screen. "Check tickets" (SCRUM-1014, ticketing parked)
 * is a section of it while the event sells natively.
 */
export default async function DoorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await loadEventPage(id)
  const { event, permissions } = data
  const offered = eventTabsFor(event.start_time.toISOString(), event.end_time.toISOString(), {
    canOperate: permissions.canOperate,
    canEdit: permissions.canEdit,
    canViewAttendees: permissions.canViewAttendees,
    kind: event.kind,
    status: event.status,
    ticketing: data.ticketing,
  }).some((t) => t.key === "door")
  const tickets = data.ticketing === "native" && event.ticketing_mode === "native"
  // A URL is not a tab list: outside the door window, the overview.
  if (!offered && !tickets) redirect(`/dashboard/events/${id}`)
  const [initial, count] = await Promise.all([offered ? readDoor(id, false) : null, tickets ? doorCount(id) : null])
  const clock = eventClock(event.timezone)

  return (
    <div className="flex flex-col gap-5">
      {/* Owned header (`OWNED_HEADERS`): the event's own, with its tabs. */}
      <EventHeader data={data} active="door" />
      {initial ? <DoorTab eventId={id} title={event.title} timezone={clock.zone} initial={initial} /> : null}
      {count ? (
        <Panel title="Check tickets">
          <DoorClient eventId={id} timezone={clock.zone} initialCount={count} />
        </Panel>
      ) : null}
    </div>
  )
}
