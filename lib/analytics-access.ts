import "server-only"

import { distinctAttendeeCounts } from "./attendee-counts"
import { db } from "./db"
import { MIN_CELL } from "./disclosure"
import { eventPassesFor, liveEntitlement } from "./entitlements"
import { realEventsWhere } from "./event-kind"

/**
 * Who may see which paid analytics, for one organisation (plan v2 §9.1b).
 *
 * ## The rule
 *
 * 1. **Analytics** — a paid subscription or an admin's grant — opens
 *    everything: every cross-event view, and every event's pass features.
 * 2. **Until the paywall starts, everything is open.** It starts 30 days after
 *    the end of the organisation's first event that clears the privacy floor
 *    (at least `MIN_CELL` people checked in). An organisation whose events have
 *    all been too small to show anything has nothing to pay for yet, so the
 *    clock has not started (audit §5.1: a first event of six shows held-back
 *    tiles and sells nothing). Once found, the date and the event are written
 *    to the organisation ONCE (`analytics_free_until`, `first_free_event_id`)
 *    and never re-derived, so soft-deleting that event, or a check-in fixed
 *    later, cannot restart the 30 days.
 * 3. **That first event's analytics stay free for good.**
 * 4. **An Event Pass** opens one event's pass features.
 *
 * Every paid figure is computed only after this says yes
 * (`lib/org-analytics.ts`); a locked screen is drawn from
 * `lib/sample-analytics.ts` and never touches the organisation's rows.
 */

export const FREE_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export type AccessReason = "analytics" | "grant" | "free_window" | "free"

export interface AnalyticsAccess {
  orgId: string
  /** The cross-event views: cohorts, comparison, pacing vs your median, ranges. */
  org: boolean
  reason: AccessReason
  /** When the free window closes. Null while no event has cleared the floor (the clock has not started). */
  freeUntil: Date | null
  /** When a paid subscription or a grant ends. Null for a free org, or one that never ends. */
  paidUntil: Date | null
  /** The first event that cleared the floor: free for good. */
  firstFreeEventId: string | null
  /** Events with an Event Pass. */
  passEventIds: string[]
}

/** The decision itself, from facts already loaded. Pure, for DK-U01. */
export function decideAccess(input: {
  entitled: "analytics" | "grant" | null
  /** The written-once end of the free window; null while no event has cleared the floor. */
  freeUntil: Date | null
  now: Date
}): { org: boolean; reason: AccessReason; freeUntil: Date | null } {
  const { freeUntil } = input
  if (input.entitled) return { org: true, reason: input.entitled, freeUntil }
  if (freeUntil === null || input.now < freeUntil) return { org: true, reason: "free_window", freeUntil }
  return { org: false, reason: "free", freeUntil }
}

/** May this event's pass features be computed and shown? */
export function mayOpenEvent(access: AnalyticsAccess, eventId: string): boolean {
  return access.org || access.firstFreeEventId === eventId || access.passEventIds.includes(eventId)
}

/**
 * The organisation's first event that has ended with at least `MIN_CELL`
 * people checked in. Oldest first; stops at the first that qualifies.
 */
async function firstQualifyingEvent(orgId: string, now: Date): Promise<{ id: string; end: Date } | null> {
  const PAGE = 50
  for (let skip = 0; ; skip += PAGE) {
    const ended = await db.events.findMany({
      where: { organizer_org_id: orgId, deleted_at: null, end_time: { lt: now }, ...realEventsWhere },
      orderBy: [{ end_time: "asc" }, { id: "asc" }],
      skip,
      take: PAGE,
      select: { id: true, end_time: true },
    })
    if (ended.length === 0) return null
    const people = await distinctAttendeeCounts(ended.map((e) => e.id))
    const first = ended.find((e) => (people.get(e.id) ?? 0) >= MIN_CELL)
    if (first) return { id: first.id, end: first.end_time }
    if (ended.length < PAGE) return null
  }
}

/**
 * The organisation's free window, from its row once written; otherwise found
 * now and written once (a concurrent first read writes the same answer, and
 * only the first write lands).
 */
async function freeWindow(orgId: string, now: Date): Promise<{ until: Date; eventId: string } | null> {
  const org = await db.organisations.findUnique({
    where: { id: orgId },
    select: { analytics_free_until: true, first_free_event_id: true },
  })
  if (org?.analytics_free_until && org.first_free_event_id) {
    return { until: org.analytics_free_until, eventId: org.first_free_event_id }
  }
  const first = await firstQualifyingEvent(orgId, now)
  if (!first) return null
  const until = new Date(first.end.getTime() + FREE_WINDOW_DAYS * DAY_MS)
  await db.organisations.updateMany({
    where: { id: orgId, analytics_free_until: null },
    data: { analytics_free_until: until, first_free_event_id: first.id },
  })
  const kept = await db.organisations.findUnique({
    where: { id: orgId },
    select: { analytics_free_until: true, first_free_event_id: true },
  })
  return kept?.analytics_free_until && kept.first_free_event_id
    ? { until: kept.analytics_free_until, eventId: kept.first_free_event_id }
    : { until, eventId: first.id }
}

export async function analyticsAccess(orgId: string, now: Date = new Date()): Promise<AnalyticsAccess> {
  const subject = { kind: "org" as const, id: orgId }
  const [live, window] = await Promise.all([liveEntitlement(subject, "analytics", now), freeWindow(orgId, now)])
  const decision = decideAccess({
    entitled: live ? (live.source === "grant" ? "grant" : "analytics") : null,
    freeUntil: window?.until ?? null,
    now,
  })
  const passes = decision.org ? new Set<string>() : await eventPassesFor(orgId, undefined, now)
  return {
    orgId,
    ...decision,
    paidUntil: live?.expiresAt ?? null,
    firstFreeEventId: window?.eventId ?? null,
    passEventIds: [...passes],
  }
}
