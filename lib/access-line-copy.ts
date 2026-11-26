import { FREE_WINDOW_DAYS } from "@/lib/analytics-access"
import { FREE_WHILE_LAUNCHING } from "@/lib/billing-plans"
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

const EVERY_VIEW = "Every view, for every event."

export interface AccessLineCopy {
  headline: string
  detail: string
}

/**
 * One case per `AccessReason`; a new reason without its words fails the build
 * (the `never` below). Where plans are not sold ("market", SCRUM-1277) the
 * line is design/05's sentence and says no date, price or plan.
 */
export function analyticsAccessLine(access: AnalyticsPageView["access"], day: (iso: string) => string): AccessLineCopy {
  const first = access.firstFreeEvent
  const dated = access.date ? `${access.date.word} ${day(access.date.at)}` : null
  const reason = access.reason
  switch (reason) {
    case "grant":
      return {
        headline: dated ? `Founding grant, ${dated}` : "Founding grant",
        detail: "Blend’n has given your organisation Analytics. Nothing is charged.",
      }
    case "analytics":
      return { headline: dated ? `Analytics, ${dated}` : "Analytics", detail: EVERY_VIEW }
    case "market":
      return { headline: FREE_WHILE_LAUNCHING, detail: EVERY_VIEW }
    case "free_window":
      if (access.freeUntil && first) {
        return {
          headline: `Open until ${day(access.freeUntil)}`,
          detail: `${first.title}, ${FIRST_EVENT_RULE}, ended ${day(first.endedAt)}. Everything here is open until ${FREE_WINDOW_DAYS} days after it. After that ${first.title} stays open for good, and Event Insights or Analytics opens the rest.`,
        }
      }
      return {
        headline: "Open for now",
        detail: `Everything here is open until ${FREE_WINDOW_DAYS} days after ${FIRST_EVENT_RULE}.`,
      }
    case "free":
      return {
        headline: "Free plan",
        detail: first
          ? `${first.title} stays open for good. Event Insights opens another event; Analytics opens everything.`
          : "Event Insights opens one event; Analytics opens everything.",
      }
    default: {
      const unhandled: never = reason
      throw new Error(`No access line for ${String(unhandled)}`)
    }
  }
}
