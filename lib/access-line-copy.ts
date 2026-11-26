import { FREE_WINDOW_DAYS } from "@/lib/analytics-access"
import { MIN_ATTENDEES } from "@/lib/connection-metrics"
import type { AnalyticsPageView } from "@/lib/org-analytics"

/**
 * The words for "what can I see, and until when" on the Analytics page, and the
 * one phrase the Plan page shares with it (step 16f).
 *
 * The line used to say "your first event that cleared the privacy floor": the
 * floor is an internal term, and an organiser reading it could not tell what
 * they had to do for it to apply. The rule is `MIN_ATTENDEES` people checked in,
 * and it is said that way wherever it appears. The window's headline is the date, "Open
 * until 23 Oct", on Analytics, as the Plan page's "Free · Analytics open until"
 * is on Plan: the same state is not called "Free" on one screen and "open" on
 * the other.
 */
export const FIRST_EVENT_RULE = `your first event with at least ${MIN_ATTENDEES} people checked in`

export interface AccessLineCopy {
  headline: string
  detail: string
}

export function analyticsAccessLine(access: AnalyticsPageView["access"], day: (iso: string) => string): AccessLineCopy {
  const first = access.firstFreeEvent
  const dated = access.date ? `${access.date.word} ${day(access.date.at)}` : null
  if (access.reason === "grant") {
    return {
      headline: dated ? `Founding grant, ${dated}` : "Founding grant",
      detail: "Blend’n has given your organisation Analytics. Nothing is charged.",
    }
  }
  if (access.reason === "analytics") {
    return { headline: dated ? `Analytics, ${dated}` : "Analytics", detail: "Every view, for every event." }
  }
  if (access.reason === "free_window" && access.freeUntil && first) {
    return {
      headline: `Open until ${day(access.freeUntil)}`,
      detail: `${first.title}, ${FIRST_EVENT_RULE}, ended ${day(first.endedAt)}. Everything here is open until ${FREE_WINDOW_DAYS} days after it. After that ${first.title} stays open for good, and Event Insights or Analytics opens the rest.`,
    }
  }
  if (access.reason === "free_window") {
    return {
      headline: "Open for now",
      detail: `Everything here is open until ${FREE_WINDOW_DAYS} days after ${FIRST_EVENT_RULE}.`,
    }
  }
  return {
    headline: "Free plan",
    detail: first
      ? `${first.title} stays open for good. Event Insights opens another event; Analytics opens everything.`
      : "Event Insights opens one event; Analytics opens everything.",
  }
}
