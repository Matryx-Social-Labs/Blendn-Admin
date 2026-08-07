import { notFound, redirect } from "next/navigation"

import { LiveTab } from "@/components/dashboard/live-tab"
import { Badge } from "@/components/ui/badge"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { getEventOverview } from "@/lib/event-overview"

import { EventTabs, eventTabsFor, type EventTabKey } from "./event-tabs"
import { Overview } from "./overview"

export const dynamic = "force-dynamic"

/** Hours the chatroom stays open after an event for feedback. */
const FEEDBACK_WINDOW_HOURS = 24

/**
 * The event's front door.
 *
 * This page used to render the staged editor, so opening an event to see how it
 * was doing put you in a seven-stage form. The editor now lives at
 * `/dashboard/events/[id]/edit`; this answers the question instead of asking
 * you to re-type the answer.
 *
 * `?tab=` is kept as the contract — `eventTabsFor` already builds against it,
 * and bookmarks, the command palette and the notification deep links all use
 * it. Changing the URL shape would strand every one of them for nothing.
 *
 * The panels below Overview are **not** reimplemented here. Attendees, chat and
 * feedback each have one implementation already, and this routes to them rather
 * than growing a second.
 */
export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const { id } = await params
  const { tab: requestedTab } = await searchParams

  const event = await db.events.findFirst({
    where: { id, deleted_at: null },
    select: {
      id: true,
      title: true,
      status: true,
      start_time: true,
      end_time: true,
      venue_name: true,
      city: true,
      organizer_id: true,
      organizer_org_id: true,
      venue: { select: { name: true, owner_org_id: true } },
    },
  })
  if (!event) notFound()

  /**
   * Gated on `canOperate`, deliberately, and not on `canEdit`.
   *
   * A venue owner cannot edit an event in their building but has every reason
   * to open it — the live view, the attendee count, the chatroom. Gating this
   * page on canEdit locked them out of the event entirely, which is the bug the
   * operational bucket exists to prevent.
   */
  const permissions = eventPermissions(await actorFor(session.user), event)
  if (!permissions.canOperate) redirect("/dashboard/events")

  const feedbackWindowOpen =
    Date.now() < event.end_time.getTime() + FEEDBACK_WINDOW_HOURS * 3_600_000

  const tabs = eventTabsFor(event.start_time.toISOString(), event.end_time.toISOString(), {
    canOperate: permissions.canOperate,
    feedbackWindowOpen,
  })
  const activeTab = (tabs.find((t) => t.key === requestedTab)?.key ?? "overview") as EventTabKey

  const venueName = event.venue?.name ?? event.venue_name

  const header = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[length:var(--text-h2)] font-bold">{event.title}</h2>
            {event.status !== "published" ? (
              <Badge variant={event.status === "cancelled" ? "destructive" : "secondary"}>
                {event.status}
              </Badge>
            ) : null}
          </div>
          <p className="text-[0.8125rem] text-muted-foreground">
            {new Intl.DateTimeFormat("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(event.start_time)}
            {venueName ? ` · ${venueName}` : ""}
            {event.city ? `, ${event.city}` : ""}
          </p>
        </div>
      </div>
      <EventTabs eventId={event.id} active={activeTab} tabs={tabs} />
    </div>
  )

  if (activeTab === "live") {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <LiveTab
          eventId={event.id}
          startAt={event.start_time.toISOString()}
          endAt={event.end_time.toISOString()}
        />
      </div>
    )
  }

  if (activeTab === "feedback") redirect(`/dashboard/events/${event.id}/feedback`)

  if (activeTab === "chat" || activeTab === "attendees") {
    // One implementation of each, on the messaging route. Routed to rather than
    // duplicated here.
    redirect(
      activeTab === "chat"
        ? `/dashboard/events/${event.id}/messaging`
        : `/dashboard/events/${event.id}/messaging?view=${activeTab}`
    )
  }

  const overview = await getEventOverview(event.id)
  if (!overview) notFound()

  return (
    <div className="flex flex-col gap-5">
      {header}
      <Overview
        overview={overview}
        eventId={event.id}
        canEdit={permissions.canEdit}
        venueName={venueName}
      />
    </div>
  )
}
