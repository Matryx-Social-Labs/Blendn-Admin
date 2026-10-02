import { notFound, redirect } from "next/navigation"

import { EventHeader } from "@/components/dashboard/event-header"
import { EventShare } from "@/components/dashboard/event-share"
import { Panel } from "@/components/dashboard/kit"
import { LiveTab } from "@/components/dashboard/live-tab"
import { EventMessaging } from "@/components/event-messaging"
import { EventSponsors } from "@/components/event-sponsors"
import { eventTitleFor } from "@/lib/dashboard-record-titles"
import { issuesFor } from "@/lib/event-issues"
import { alertsForVenue } from "@/lib/live-metrics"
import { getEventAttendance } from "@/lib/attendance"
import { getConnectionMetrics } from "@/lib/connection-metrics"
import { canBroadcast } from "@/lib/rbac"
import { resolveSponsorGrant } from "@/lib/org-membership"
import { getEventOverview } from "@/lib/event-overview"
import { discloseHeadcount } from "@/lib/disclosure"
import { eventAttendees } from "@/lib/attendee-roster"
import { loadEventPage } from "@/lib/event-page"
import { EVENT_LINKS_LIVE, eventShareUrl } from "@/lib/event-share"

import { EventAttendeesCount, EventAttendeesTable } from "./attendees-table"
import { eventTabsFor, sharesLink } from "./event-tabs"
import { Overview } from "./overview"
import { curationState } from "@/lib/curation"
import { eventRefusals, refusalSummary } from "@/lib/check-in-refusals"
import { CurationHealth } from "./curation-health"
import { eventClock } from "@/lib/event-phase"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: (await eventTitleFor((await params).id)) ?? "Event" }
}

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
 * Room chat and Feedback are their own routes under the same header and tabs
 * (`EventHeader`); this page renders the rest. Attendees renders here. It used
 * to be routed to `/messaging?view=attendees`, but nothing read `view` and no
 * per-event attendee list existed, so the tab landed on the room chat
 * (SCRUM-499). Announcements & sponsors — the composer and the placements —
 * moved here from the Room page, where they shared a column with the feed
 * (step 15), and the QR & link tab is new.
 */
export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { id } = await params
  const { tab: requestedTab } = await searchParams

  const data = await loadEventPage(id)
  const { event, actor, permissions } = data
  const now = new Date()

  const tabs = eventTabsFor(event.start_time.toISOString(), event.end_time.toISOString(), {
    canOperate: permissions.canOperate,
    canEdit: permissions.canEdit,
    canViewAttendees: permissions.canViewAttendees,
    kind: event.kind,
    status: event.status,
  })
  // Room chat and Feedback are their own routes; old `?tab=` links still land there.
  if (requestedTab === "feedback") redirect(`/dashboard/events/${event.id}/feedback`)
  if (requestedTab === "chat") redirect(`/dashboard/events/${event.id}/messaging`)
  const activeTab = tabs.find((t) => t.key === requestedTab)?.key
  // A tab this viewer is not offered — the code for a draft, a venue day or a
  // night another host runs, the composer for a venue — is a URL, not a way
  // round the tab list: back to the overview, as an address the bar can show.
  if (requestedTab && requestedTab !== "overview" && !activeTab) redirect(`/dashboard/events/${event.id}`)

  const venueName = event.venue?.name ?? event.venue_name
  const clock = eventClock(event.timezone)

  /*
   * This page owns its header (`OWNED_HEADERS`): the event is named by its own
   * title, which only this page has loaded and checked the viewer may see.
   * Room chat and Feedback render the same header and tabs.
   */
  const header = <EventHeader data={data} active={activeTab ?? "overview"} now={now} />

  if (activeTab === "live") {
    const issues = await issuesFor(event.id)
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
           *
           * Their bodies carry the night's counts ("3 of 12 have checked out"),
           * so a venue gets the ones it is sent live, each as its figure-free
           * sentence (SCRUM-516), here on the server: the props are in the
           * page's payload.
           */
          issues={permissions.canEdit ? issues : alertsForVenue(issues)}
        />
      </div>
    )
  }

  if (activeTab === "share") {
    // Offered only by `sharesLink`; asked again, because a URL is not a tab list.
    if (!sharesLink({ canEdit: permissions.canEdit, kind: event.kind, status: event.status })) {
      redirect(`/dashboard/events/${event.id}`)
    }
    return (
      <div className="flex flex-col gap-5">
        {header}
        <EventShare
          url={eventShareUrl(event.id)}
          title={event.title}
          when={`${clock.dateTime(event.start_time)}${venueName ? ` · ${venueName}` : ""}`}
          linksLive={EVENT_LINKS_LIVE}
        />
      </div>
    )
  }

  if (activeTab === "announcements") {
    // Offered only on canEdit (`eventTabsFor`); asked again here, because a
    // URL is not a tab list.
    if (!permissions.canEdit) redirect(`/dashboard/events/${event.id}`)
    // What the sponsored-message routes allow, asked the same way they ask it,
    // so the composer offers only what will be accepted (SCRUM-308).
    const mayAuthorSponsored = canBroadcast(actor, event, "sponsored", (await resolveSponsorGrant(actor, event.id)) ?? undefined)
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 @4xl/main:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="Into the room" hint="announcements, polls and sponsored messages">
            <EventMessaging eventId={event.id} mayAuthorSponsored={mayAuthorSponsored} />
          </Panel>
          {/* A sponsored campaign is refused without a placement, and the fix
              for that refusal lives here. */}
          <Panel title="Sponsors" hint="the brands placed at this event">
            <EventSponsors eventId={event.id} />
          </Panel>
        </div>
      </div>
    )
  }

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
  const venueMaySee = (people: number) => !venueView || discloseHeadcount(people) !== null

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
    // Not the venue's either: its suppressed state names the attendee count
    // ("With 3, ..."), and its figures are about who met whom.
    hasRun && !venueView ? getConnectionMetrics(event.id) : null,
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
