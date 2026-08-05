import Link from "next/link"

import { cn } from "@/lib/utils"
import { livePhaseFor } from "@/components/dashboard/live-tab"

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
  opts: { canOperate: boolean; feedbackWindowOpen: boolean }
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
    tabs.push({ key: "attendees", label: "Attendees" })
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
    <nav className="flex flex-wrap gap-1.5" aria-label="Event sections">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={
            tab.key === "overview"
              ? `/dashboard/events/${eventId}`
              : `/dashboard/events/${eventId}?tab=${tab.key}`
          }
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "rounded-full border border-border px-3 py-1.5 text-[0.8125rem] transition-colors",
            tab.key === active
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          {tab.label}
          {tab.key === "live" ? (
            <span
              aria-hidden
              className="ml-1.5 inline-block size-1.5 animate-pulse rounded-full bg-destructive align-middle"
            />
          ) : null}
        </Link>
      ))}
    </nav>
  )
}
