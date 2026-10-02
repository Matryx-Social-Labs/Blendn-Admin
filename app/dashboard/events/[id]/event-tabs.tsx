import { PillTabs } from "@/components/dashboard/kit"
import { livePhaseFor } from "@/lib/event-phase"

export type EventTabKey = "overview" | "live" | "attendees" | "chat" | "announcements" | "feedback" | "share"

/**
 * Event detail navigation, in the kit's order (step 15).
 *
 * Tabs are lifecycle-aware: Live only exists while the event runs, Feedback
 * once it has ended. Showing a Live tab on an event three weeks out trains
 * people to ignore tabs.
 *
 * Feedback stays once the 24-hour window has closed. It used to vanish with
 * the window, while the digest and the stars behind it stayed readable — so an
 * organiser looking for last week's feedback found no way to it but a URL.
 *
 * Every chatroom *is* an event's chatroom, so the room is a tab here rather
 * than a trip to a separate screen that loses the event you were looking at.
 */
export function eventTabsFor(
  startAt: string,
  endAt: string,
  opts: { canOperate: boolean; canEdit: boolean; canViewAttendees: boolean }
): Array<{ key: EventTabKey; label: string }> {
  const phase = livePhaseFor(startAt, endAt)
  const tabs: Array<{ key: EventTabKey; label: string }> = [{ key: "overview", label: "Overview" }]

  // Everything below the overview requires operational access — an organiser
  // or the owner of the venue it is held at. Live belongs in that set: it is
  // attendance and chat data, not a public summary, and the socket room behind
  // it gates on exactly this. The page already refuses entry without it, but a
  // tab list that offers something the server will deny is its own bug.
  if (opts.canOperate) {
    if (phase === "live") tabs.push({ key: "live", label: "Live" })
    // Not on a venue day for its venue's owner, who moderates the room and
    // never sees who was in it (F1).
    if (opts.canViewAttendees) tabs.push({ key: "attendees", label: "Attendees" })
    tabs.push({ key: "chat", label: "Room chat" })
    // Speaking into the room and placing sponsors is whoever runs the event;
    // a venue owner announcing into a night they do not run is K3.12 (R37).
    if (opts.canEdit) tabs.push({ key: "announcements", label: "Announcements & sponsors" })
    if (phase === "post") tabs.push({ key: "feedback", label: "Feedback" })
    // The code is the event's public address: nothing an operator may not see.
    tabs.push({ key: "share", label: "QR & link" })
  }
  return tabs
}

/** Where a tab lives. Room chat and Feedback are their own routes; the rest are `?tab=`. */
export function eventTabHref(eventId: string, key: EventTabKey): string {
  if (key === "overview") return `/dashboard/events/${eventId}`
  if (key === "chat") return `/dashboard/events/${eventId}/messaging`
  if (key === "feedback") return `/dashboard/events/${eventId}/feedback`
  return `/dashboard/events/${eventId}?tab=${key}`
}

export function EventTabs({
  eventId,
  active,
  tabs,
}: {
  eventId: string
  active: EventTabKey
  tabs: Array<{ key: EventTabKey; label: string }>
}) {
  return (
    <PillTabs
      label="Event sections"
      active={active}
      tabs={tabs.map((tab) => ({
        key: tab.key,
        label: tab.label,
        href: eventTabHref(eventId, tab.key),
        live: tab.key === "live",
      }))}
    />
  )
}
