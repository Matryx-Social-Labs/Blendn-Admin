// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import type { Prisma, user_role } from "@prisma/client"

import { db } from "./db"
import { realEventsWhere } from "./event-kind"
import { hostNotSuspended } from "./event-access"
import { actorFor } from "./org-membership"

/**
 * Which events this person may see listed.
 *
 * ## Why it is a module
 *
 * The three clauses mirror `eventPermissions.canOperate` exactly, and getting
 * them slightly wrong has a signature that nobody reports as a bug: a colleague
 * at the same organisation opens the list and it is **empty**, because they
 * personally created nothing. That is H2 in the register, and `GET /api/events`
 * carries a long comment about having fixed it — while
 * `app/dashboard/events/page.tsx` fetched from that route and the dashboard's
 * own actions scoped a different way.
 *
 * Two readers of one question is the shape this codebase keeps paying for. The
 * dashboard list and the API now call this, so they cannot answer differently.
 *
 * ## Not `eventPermissions`
 *
 * That resolver answers "what may this actor do with THIS event" and needs the
 * row. This is the `where` that decides which rows to fetch at all. They must
 * agree, and `__tests__/event-visibility.test.ts` is what holds them together.
 */
export async function visibleEventsWhere(user: {
  id: string
  role: user_role
}): Promise<Prisma.eventsWhereInput> {
  return (await visibleEventsScope(user)).where
}

/**
 * The same `where`, with the actor it was built for — so a screen that has to
 * tell the events a venue owner runs from the ones they reach through the
 * building (`hostsEvent`) does not load the memberships a second time.
 */
export async function visibleEventsScope(user: {
  id: string
  role: user_role
}): Promise<{ where: Prisma.eventsWhereInput; actor: { id: string; orgIds: string[] } }> {
  // Venue days are nobody's to list (step 3): their owner reaches the room
  // from the venue, and an admin from the moderation queue.
  const where: Prisma.eventsWhereInput = { deleted_at: null, ...realEventsWhere }
  if (user.role === "app_admin") return { where, actor: { id: user.id, orgIds: [] } }

  const actor = await actorFor(user)

  /*
   * Membership, not `User.role`, as in `eventPermissions` (SCRUM-1246): any
   * member of an org sees the events it runs, and the events at the venues it
   * owns from each claim on. This was gated on the role — a sponsor in an
   * organising org saw none of its events, because the resolver refused them
   * row by row. The resolver now grants them by membership, so the list shows
   * them; a list and a resolver that disagree is H2 either way round.
   */
  where.OR = [
    ...(actor.orgIds.length
      ? [
          { organizer_org_id: { in: actor.orgIds } },
          // A venue's org operates every event in its building, whoever
          // created it, from the claim on — `eventPermissions` grants exactly
          // that, so the list shows exactly that.
          ...(await claimedVenueEventsWhere(actor.orgIds)),
        ]
      : []),
    /*
     * Kept so an event created before organisations existed, or by somebody
     * whose org link is missing, stays visible to its creator.
     *
     * This is the legacy fallback A1/A2 describe, and it is deliberately NOT in
     * `eventPermissions` — seeing a row you cannot open is a smaller failure
     * than a row you created vanishing. Delete it when `organizer_org_id` has
     * been backfilled everywhere, not before.
     *
     * Gated on the host not being suspended (SCRUM-8): the org clause above
     * already drops a suspended org's events because `actorFor` no longer
     * loads that membership, and this arm would put them straight back for
     * whoever created them — a list full of rows that do not open.
     *
     * Only for an event with no organisation (SCRUM-942, owner row A-16, decided by lean on 2026-10-31): an event that
     * has one is its members', and a creator who left that org must lose it, as `eventPermissions` already says.
     */
    { organizer_id: user.id, organizer_org_id: null, ...hostNotSuspended },
  ]
  return { where, actor: { id: user.id, orgIds: actor.orgIds } }
}

/**
 * When a venue owner's view of one venue's events starts: its claim (SCRUM-355).
 *
 * The `start_time` filter for that venue's events as its owner sees them, cut
 * to `range` when one is given (the later of the range's start and the claim).
 * Null when the venue has no claim date: an owned venue without one is bad
 * data, and it opens no history, as in the resolver.
 *
 * Every screen and export that reads one venue's events for its owner goes
 * through this — the venue page, the building's live count, the linked-events
 * list and the link actions. `__tests__/authz-scoping-boundary.test.ts` holds
 * them to it. A multi-day event that began before the claim stays out, as it
 * does in `eventPermissions`: the rule is the start.
 */
export function claimedWindow(
  venue: { claimed_at: Date | null },
  range?: { from: Date; to: Date }
): { gte: Date; lt?: Date } | null {
  if (!venue.claimed_at) return null
  if (!range) return { gte: venue.claimed_at }
  return { gte: range.from > venue.claimed_at ? range.from : venue.claimed_at, lt: range.to }
}

/** True when this event starts inside the venue's claim window. */
export function startsAfterClaim(venue: { claimed_at: Date | null }, startTime: Date): boolean {
  const window = claimedWindow(venue)
  return window !== null && startTime >= window.gte
}

/**
 * The events a venue owner reaches through the building: at a venue their
 * organisation owns, starting at or after that venue's claim.
 *
 * Owner's ruling (SCRUM-355): a claim opens what happens at the venue from then
 * on, never its past. `eventPermissions` held that row by row while the list
 * and every CSV scoped on `owner_org_id` alone, so a new owner downloaded one
 * check-in row per guest, by label, for nights before they owned the place
 * (SCRUM-500). Every venue-owner scope builds its venue arm here, and
 * `__tests__/authz-scoping-boundary.test.ts` refuses one written by hand.
 *
 * One arm per venue because the claim date is per venue and Prisma cannot
 * compare a column to a related row's column.
 *
 * ponytail: one OR arm per owned venue. Fine for the handful an org owns; a
 * raw-SQL join on `venues.claimed_at` if an org ever owns hundreds.
 */
export async function claimedVenueEventsWhere(
  orgIds: readonly string[]
): Promise<Prisma.eventsWhereInput[]> {
  if (orgIds.length === 0) return []
  const venues = await db.venues.findMany({
    where: { owner_org_id: { in: [...orgIds] } },
    select: { id: true, claimed_at: true },
  })
  return venues.flatMap((v) => {
    const window = claimedWindow(v)
    return window ? [{ venue_id: v.id, start_time: window }] : []
  })
}

/**
 * Are this event's counts held back from this viewer (SCRUM-501)? Yes when
 * they reach it through the building rather than run it — whatever their
 * User.role (SCRUM-1246) — and never for the platform's admin. The one rule
 * for the events list and the exports.
 */
export function reachedThroughBuilding(
  role: user_role,
  actor: { id: string; orgIds: readonly string[] },
  event: { organizer_id: string; organizer_org_id: string | null }
): boolean {
  return role !== "app_admin" && !hostsEvent(actor, event)
}

/**
 * Does this actor run the event, rather than reach it through the building?
 *
 * The organising org, or — the floor `visibleEventsWhere` keeps — its creator.
 * A venue owner whose organisation hosts its own events (SCRUM-320) sees those
 * as their organiser does; everything else they reach as the venue, and gets
 * counts held back under the floor (SCRUM-501).
 */
export function hostsEvent(
  actor: { id: string; orgIds: readonly string[] },
  event: { organizer_id: string; organizer_org_id: string | null }
): boolean {
  return (
    event.organizer_id === actor.id ||
    (event.organizer_org_id !== null && actor.orgIds.includes(event.organizer_org_id))
  )
}
