import { notFound, redirect } from "next/navigation"

import { LiveTab } from "@/components/dashboard/live-tab"
import { issuesFor } from "@/lib/event-issues"
import { getEventAttendance } from "@/lib/attendance"
import { getConnectionMetrics } from "@/lib/connection-metrics"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { getEventOverview } from "@/lib/event-overview"
import { discloseHeadcount } from "@/lib/disclosure"
import { eventAttendees } from "@/lib/attendee-roster"

import { EventAttendeesCount, EventAttendeesTable } from "./attendees-table"
import { EventTabs, eventTabsFor, type EventTabKey } from "./event-tabs"
import { Overview } from "./overview"
import { curationSelect, curationState } from "@/lib/curation"
import { eventRefusals, refusalSummary } from "@/lib/check-in-refusals"
import { CurationHealth } from "./curation-health"
import { EventVenueLink } from "./venue-link"
import { EventLifecycle } from "@/components/dashboard/event-lifecycle"
import { eventClock, eventStateFor } from "@/lib/event-phase"
import { CHAT_WINDOW_HOURS } from "@/lib/chat-window"

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
 * Chat and feedback are **not** reimplemented here: each has one
 * implementation already, and this routes to it rather than growing a second.
 * Attendees renders here. It used to be routed to `/messaging?view=attendees`
 * on the same theory, but nothing read `view` and no per-event attendee list
 * existed, so the tab landed on the room chat (SCRUM-499).
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
      created_at: true,
      start_time: true,
      end_time: true,
      timezone: true,
      venue_name: true,
      city: true,
      organizer_id: true,
      organizer_org_id: true,
      venue: { select: { name: true, owner_org_id: true, claimed_at: true } },
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
  const actor = await actorFor(session.user)
  const permissions = eventPermissions(actor, event)
  if (!permissions.canOperate) redirect("/dashboard/events")

  const now = new Date()
  const feedbackWindowOpen =
    now.getTime() < event.end_time.getTime() + FEEDBACK_WINDOW_HOURS * 3_600_000

  const tabs = eventTabsFor(event.start_time.toISOString(), event.end_time.toISOString(), {
    canOperate: permissions.canOperate,
    feedbackWindowOpen,
  })
  const activeTab = (tabs.find((t) => t.key === requestedTab)?.key ?? "overview") as EventTabKey

  const venueName = event.venue?.name ?? event.venue_name
  const lifecycleState = eventStateFor(event)
  // The event's own clock, not the server's (SCRUM-421).
  const clock = eventClock(event.timezone)
  const { day, time } = clock
  const daysUntil = clock.daysUntil(event.start_time, now)
  const lifecycleDates = {
    draft: `created ${day(event.created_at)}`,
    upcoming:
      lifecycleState === "upcoming"
        ? daysUntil <= 0
          ? "doors today"
          : `doors in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`
        : lifecycleState === "draft"
          ? "not yet published"
          : "published",
    live: `${day(event.start_time)} ${time(event.start_time)} – ${time(event.end_time)}`,
    over: `feedback open ${CHAT_WINDOW_HOURS}h after`,
  }

  const header = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-[length:var(--text-h2)] font-bold">{event.title}</h2>
          {/* One line: when, where, and — for somebody who may edit a linked venue — the way out of a wrong link. */}
          <p className="flex flex-wrap items-center gap-x-1 text-[0.8125rem] text-muted-foreground">
            <span>
              {clock.dateTime(event.start_time)}
              {" – "}
              {time(event.end_time)}
              {venueName ? ` · ${venueName}` : ""}
              {event.city ? `, ${event.city}` : ""}
            </span>
            {event.venue && permissions.canEdit ? (
              <EventVenueLink eventId={event.id} venueName={venueName ?? "this venue"} />
            ) : null}
          </p>
          <EventLifecycle state={lifecycleState} cancelled={event.status === "cancelled"} dates={lifecycleDates} />
          {/*
            Only when a venue RECORD is linked, and only for somebody who may
            edit. `venue_name` alone is free text the organiser typed — there is
            nothing to unlink from — and a venue owner reading this page has the
            dispute flow instead, which is the other side of the same question.
          */}
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
          timezone={event.timezone}
          /*
           * Server-fetched rather than socket-pushed, deliberately. The alerts
           * above are live; this is the record of what already happened, and
           * "the queue cleared itself twenty minutes ago" does not need to
           * arrive within a second — it needs to exist at all, which is what
           * a browser-only `useMemo` could never manage.
           */
          issues={await issuesFor(event.id)}
        />
      </div>
    )
  }

  if (activeTab === "feedback") redirect(`/dashboard/events/${event.id}/feedback`)
  if (activeTab === "chat") redirect(`/dashboard/events/${event.id}/messaging`)

  if (activeTab === "attendees") {
    // Labels, never names (R1, SCRUM-383 b), for whoever runs the event; a
    // count, never people, for the venue it is held at.
    const attendees = await eventAttendees(actor, event.id, now)
    if (!attendees) notFound()
    return (
      <div className="flex flex-col gap-5">
        {header}
        {attendees.view === "labels" ? (
          <EventAttendeesTable
            roster={attendees}
            timezone={event.timezone}
            startAt={event.start_time.toISOString()}
          />
        ) : (
          <EventAttendeesCount started={attendees.started} came={attendees.came} />
        )}
      </div>
    )
  }

  /*
   * The venue's view of somebody else's event: aggregates, never people, every
   * count of people held back under the floor -- the same rule as its
   * Attendees tab, which would mean nothing if this tab printed what that one
   * holds back.
   */
  const venueView = !permissions.canEdit
  const venueMaySee = (people: number) => !venueView || discloseHeadcount(people).value !== null

  const overview = await getEventOverview(event.id, venueView ? "venue" : "host")
  if (!overview) notFound()

  /**
   * Attendance and connections only once there is something to count. A draft
   * or upcoming event has no check-ins by definition, and "0 came" against an
   * event that has not happened reads as a failure rather than as a date in
   * the future.
   */
  const hasRun = overview.state === "live" || overview.state === "over"
  const [attendance, connections, turnedAway] = await Promise.all([
    // Day by day, newcomers and returning: cells of a few people. Not a venue's.
    hasRun && !venueView ? getEventAttendance(event.id) : null,
    hasRun ? getConnectionMetrics(event.id) : null,
    /*
     * The organiser's half of the door (SCRUM-196). `refusalSummary` below is
     * the curation queue's diagnosis and stays gated on curated events; this
     * one is for whoever operates the event, and an organiser whose pin is on
     * the wrong building was the person with no way to find out.
     *
     * Before the doors as well (SCRUM-494). It was gated on the event having
     * run, on the theory that a future event has refused nobody, and the door
     * records `too_early` precisely while the event is upcoming: people
     * arriving for a start time the listing has wrong. That is the one window
     * in which the organiser can still correct it. The panel renders only when
     * somebody was refused, so an upcoming event that refused nobody is
     * unchanged. A draft cannot be checked in to at all.
     */
    overview.state !== "draft" ? eventRefusals(event.id) : null,
  ])

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
  const curated = state === "curated_open" || state === "curated_claimed"
  const refusals = !curated
    ? null
    : hasRun && turnedAway
      ? // A claimed listing that has started would otherwise read the same
        // rows twice; the organiser's read already has everything this needs.
        // Before the doors the curation read stays its own (SCRUM-494): it
        // ranks the top reason by attempts, and that headline is its job.
        {
          distinctPeopleRefused: turnedAway.people,
          attempts: turnedAway.attempts,
          medianShortfallMetres: turnedAway.medianShortfallMetres,
          topReason: turnedAway.byReason[0]?.reason ?? null,
        }
      : await refusalSummary(event.id)

  return (
    <div className="flex flex-col gap-5">
      {header}
      {refusals && refusals.attempts > 0 && venueMaySee(refusals.distinctPeopleRefused) ? (
        <CurationHealth state={state} refusals={refusals} />
      ) : null}
      <Overview
        overview={overview}
        eventId={event.id}
        canEdit={permissions.canEdit}
        venueName={venueName}
        attendance={attendance}
        connections={connections}
        turnedAway={turnedAway && venueMaySee(turnedAway.people) ? turnedAway : null}
      />
    </div>
  )
}
