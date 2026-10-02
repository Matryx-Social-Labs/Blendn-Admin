import Link from "next/link"
import { IconEdit, IconQrcode } from "@tabler/icons-react"

import { EventTabs, eventTabHref, eventTabsFor, sharesLink, type EventTabKey } from "@/app/dashboard/events/[id]/event-tabs"
import { EventVenueLink } from "@/app/dashboard/events/[id]/venue-link"
import { EventLifecycle } from "@/components/dashboard/event-lifecycle"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@/components/ui/button"
import { CHAT_WINDOW_HOURS } from "@/lib/chat-window"
import type { EventPageData } from "@/lib/event-page"
import { eventClock, eventStateFor } from "@/lib/event-phase"

/**
 * One event's header and tabs, the same on every route under it (step 15):
 * the overview, Room chat and Feedback.
 *
 * The event is named by its own title (`OWNED_HEADERS`), with the two things
 * an organiser reaches for from anywhere on it — the QR code and the editor —
 * as the header's actions. Both are `canEdit`'s (the code only for a published
 * event that is not a venue day, `sharesLink`); a venue owner operates the
 * night and hands out nobody's link.
 */
export function EventHeader({
  data: { event, permissions },
  active,
  now = new Date(),
}: {
  data: Pick<EventPageData, "event" | "permissions">
  active: EventTabKey
  now?: Date
}) {
  const venueName = event.venue?.name ?? event.venue_name
  const state = eventStateFor(event, now)
  // The event's own clock, not the server's (SCRUM-421).
  const clock = eventClock(event.timezone)
  const { day, time } = clock
  const daysUntil = clock.daysUntil(event.start_time, now)
  const lifecycleDates = {
    draft: `created ${day(event.created_at)}`,
    upcoming:
      state === "upcoming"
        ? daysUntil <= 0
          ? "doors today"
          : `doors in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`
        : state === "draft"
          ? "not yet published"
          : "published",
    live: `${day(event.start_time)} ${time(event.start_time)} – ${time(event.end_time)}`,
    over: `feedback open ${CHAT_WINDOW_HOURS}h after`,
  }
  const tabs = eventTabsFor(event.start_time.toISOString(), event.end_time.toISOString(), {
    canOperate: permissions.canOperate,
    canEdit: permissions.canEdit,
    canViewAttendees: permissions.canViewAttendees,
    kind: event.kind,
    status: event.status,
  })
  const share = sharesLink({ canEdit: permissions.canEdit, kind: event.kind, status: event.status })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={event.title}
        back={{ href: "/dashboard/events", label: "Events" }}
        actions={
          <>
            {share ? (
              <Button asChild variant="outline" className="pointer-coarse:h-11">
                <Link href={eventTabHref(event.id, "share")}>
                  <IconQrcode aria-hidden className="size-4" />
                  QR code
                </Link>
              </Button>
            ) : null}
            {permissions.canEdit ? (
              <Button asChild variant="outline" className="pointer-coarse:h-11">
                <Link href={`/dashboard/events/${event.id}/edit`}>
                  <IconEdit aria-hidden className="size-4" />
                  Edit event
                </Link>
              </Button>
            ) : null}
          </>
        }
      >
        {/* One line: when, where, and — for somebody who may edit a linked venue — the way out of a wrong link. */}
        <p className="flex flex-wrap items-center gap-x-1 text-[0.8125rem] text-muted-foreground">
          <span>
            {clock.dateTime(event.start_time)}
            {" – "}
            {time(event.end_time)}
            {venueName ? ` · ${venueName}` : ""}
            {event.city ? `, ${event.city}` : ""}
          </span>
          {/*
            Only when a venue RECORD is linked, and only for somebody who may
            edit. `venue_name` alone is free text the organiser typed — there is
            nothing to unlink from — and a venue owner reading this page has the
            dispute flow instead, which is the other side of the same question.
          */}
          {event.venue && permissions.canEdit ? (
            <EventVenueLink eventId={event.id} venueName={venueName ?? "this venue"} />
          ) : null}
        </p>
        <EventLifecycle state={state} cancelled={event.status === "cancelled"} dates={lifecycleDates} />
      </PageHeader>
      <EventTabs eventId={event.id} active={active} tabs={tabs} />
    </div>
  )
}
