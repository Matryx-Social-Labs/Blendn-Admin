import { distinctAttendeeCounts } from "./attendee-counts"
import { db } from "./db"
import { MIN_CELL } from "./disclosure"
import { eventPassesFor, hasEntitlement, liveEntitlement } from "./entitlements"
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
 *    tiles and sells nothing).
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
  qualifyingEventEnd: Date | null
  now: Date
}): { org: boolean; reason: AccessReason; freeUntil: Date | null } {
  const freeUntil = input.qualifyingEventEnd
    ? new Date(input.qualifyingEventEnd.getTime() + FREE_WINDOW_DAYS * DAY_MS)
    : null
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

export async function analyticsAccess(orgId: string, now: Date = new Date()): Promise<AnalyticsAccess> {
  const subject = { kind: "org" as const, id: orgId }
  const [entitled, live, qualifying, events] = await Promise.all([
    hasEntitlement(subject, "analytics", {}, now),
    liveEntitlement(subject, "analytics", now),
    firstQualifyingEvent(orgId, now),
    db.events.findMany({
      where: { organizer_org_id: orgId, deleted_at: null, ...realEventsWhere },
      select: { id: true },
    }),
  ])
  const decision = decideAccess({
    entitled: entitled ? (live?.source === "grant" ? "grant" : "analytics") : null,
    qualifyingEventEnd: qualifying?.end ?? null,
    now,
  })
  const passes = decision.org ? new Set<string>() : await eventPassesFor(orgId, events.map((e) => e.id), now)
  return {
    orgId,
    ...decision,
    paidUntil: entitled ? (live?.expiresAt ?? null) : null,
    firstFreeEventId: qualifying?.id ?? null,
    passEventIds: [...passes],
  }
}
