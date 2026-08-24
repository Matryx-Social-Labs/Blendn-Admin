import { notFound, redirect } from "next/navigation"

import { LiveTab } from "@/components/dashboard/live-tab"
import { Badge } from "@/components/ui/badge"
import { getEventAttendance } from "@/lib/attendance"
import { getConnectionMetrics } from "@/lib/connection-metrics"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { getEventOverview } from "@/lib/event-overview"

import { EventTabs, eventTabsFor, type EventTabKey } from "./event-tabs"
import { Overview } from "./overview"
import { curationSelect, curationState } from "@/lib/curation"
import { refusalSummary } from "@/lib/check-in-refusals"
import { CurationHealth } from "./curation-health"

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
      /*
       * Spread FIRST, deliberately. `curationSelect` claims `start_time`,
       * `end_time` and `organizer_org_id`, which this select already names --
       * spread last it wins and the explicit entries are overwritten (TS2783).
       * Same collision as `broadcastAuthorSelect` through `venue`; the values
       * are identical `true` either way, but the ordering is what makes that
       * safe rather than lucky.
       */
      ...curationSelect,
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

  /**
   * Only once there is something to count. A draft or upcoming event has no
   * check-ins by definition, and "0 came" against an event that has not
   * happened reads as a failure rather than as a date in the future.
   */
  const [attendance, connections] =
    overview.state === "live" || overview.state === "over"
      ? await Promise.all([getEventAttendance(event.id), getConnectionMetrics(event.id)])
      : [null, null]

  /*
   * The per-event half of curation health.
   *
   * The queue screen answers "which of everything we added is dead"; this
   * answers "and why is this one". `topReason` is the part the list cannot show
   * -- a wrong pin and a wrong start time both produce zero check-ins, and only
   * the dominant refusal reason tells them apart.
   *
   * Loaded only for curated events, so an organiser's own event pays nothing.
   */
  const state = curationState(event)
  const refusals =
    state === "curated_open" || state === "curated_claimed"
      ? await refusalSummary(event.id)
      : null

  return (
    <div className="flex flex-col gap-5">
      {header}
      {refusals && refusals.attempts > 0 ? (
        <CurationHealth state={state} refusals={refusals} />
      ) : null}
      <Overview
        overview={overview}
        eventId={event.id}
        canEdit={permissions.canEdit}
        venueName={venueName}
        attendance={attendance}
        connections={connections}
      />
    </div>
  )
}
