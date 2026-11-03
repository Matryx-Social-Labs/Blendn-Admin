import { redirect } from "next/navigation"

import { PageHeader } from "@/components/dashboard/page-header"
import { eventTitleFor } from "@/lib/dashboard-record-titles"
import { db } from "@/lib/db"
import { eventClock } from "@/lib/event-phase"
import { loadEventPage } from "@/lib/event-page"
import { doorCount } from "@/lib/ticket-door"

import { DoorClient } from "./door-client"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const name = await eventTitleFor((await params).id)
  return { title: name ? `Check tickets · ${name}` : "Check tickets" }
}

/**
 * "Check tickets", the door (SCRUM-1014), for whoever operates the event
 * (`canOperate`: its organization, the venue it is held at, an admin) and
 * only while it sells natively. Phone-first: door staff on their own phones
 * in a queue. Linked from the Tickets tab and from Live. Its own page with its
 * own header (`OWNED_HEADERS`), not a tab: the door needs the whole screen.
 */
export default async function DoorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { event, ticketing } = await loadEventPage(id)
  const row = await db.events.findUniqueOrThrow({ where: { id }, select: { ticketing_mode: true, start_time: true } })
  if (ticketing !== "native" || row.ticketing_mode !== "native") redirect(`/dashboard/events/${id}`)
  const count = await doorCount(id)
  const clock = eventClock(event.timezone)

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
      <PageHeader
        title="Check tickets"
        back={{ href: `/dashboard/events/${id}`, label: event.title }}
        description={`${event.title} · starts ${clock.time(row.start_time)}`}
      />
      <DoorClient eventId={id} timezone={clock.zone} initialCount={count} />
    </div>
  )
}
