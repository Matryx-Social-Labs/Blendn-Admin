import { PillTabs } from "@/components/dashboard/kit"
import { livePhaseFor } from "@/lib/event-phase"

export type EventTabKey = "overview" | "live" | "attendees" | "chat" | "feedback"

/**
 * Event detail navigation.
 *
 * Tabs are lifecycle-aware: Live only exists while the event runs, Feedback
 * only once it has ended and the chat window is still open. Showing a Live tab
 * on an event three weeks out, or a Feedback tab on one that has not happened,
 * trains people to ignore tabs.
 *
 * This also replaces the old jump to a separate Chatrooms screen. Every
 * chatroom *is* an event's chatroom, so navigating away to reach it — and
 * losing the event you were looking at — was two paths to one object.
 */
export function eventTabsFor(
  startAt: string,
  endAt: string,
  opts: { canOperate: boolean; canViewAttendees: boolean; feedbackWindowOpen: boolean }
): Array<{ key: EventTabKey; label: string }> {
  const phase = livePhaseFor(startAt, endAt)
  const tabs: Array<{ key: EventTabKey; label: string }> = [
    { key: "overview", label: "Overview" },
  ]

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
    tabs.push({ key: "chat", label: "Chat" })
    if (phase === "post" && opts.feedbackWindowOpen) {
      tabs.push({ key: "feedback", label: "Feedback" })
    }
  }
  return tabs
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
        href:
          tab.key === "overview"
            ? `/dashboard/events/${eventId}`
            : // Feedback is a real page, not a tab rendered inline — it has
              // its own data shape and is worth linking to directly.
              tab.key === "feedback"
              ? `/dashboard/events/${eventId}/feedback`
              : `/dashboard/events/${eventId}?tab=${tab.key}`,
        live: tab.key === "live",
      }))}
    />
  )
}
