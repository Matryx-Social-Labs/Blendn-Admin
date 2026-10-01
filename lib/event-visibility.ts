// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import type { user_role } from "@prisma/client"

import { db } from "./db"
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
}): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = { deleted_at: null }
  if (user.role === "app_admin") return where

  const actor = await actorFor(user)

  /*
   * The org clause is gated on the ROLE, not merely on having an org.
   *
   * `eventPermissions` denies every role outside these two outright — a sponsor
   * gets `canOperate: false` whatever their memberships. The first version of
   * this gated only the venue clause and added the base org clause for anybody
   * with `orgIds.length`, and `organisation_members` has no notion of a
   * "sponsor org" versus an "organiser org": one row can both run events and
   * hold `may_sponsor`. So a sponsor who is a member of an organising org saw
   * that org's events listed — titles, RSVPs, arrivals, host names — on a
   * screen `eventPermissions` would refuse them row by row.
   *
   * Bounded (same-organisation, and opening a row still hits the resolver) and
   * reachable: the nav hides Events from sponsors, but a nav filter is not an
   * authorization check and `/dashboard/events` answers a direct navigation.
   *
   * A resolver and a list filter that disagree is the H2 shape inverted — that
   * one hid rows somebody was entitled to, this one showed rows they were not.
   */
  const mayScopeByOrg = user.role === "organizer" || user.role === "venue_owner"

  where.OR = [
    ...(actor.orgIds.length && mayScopeByOrg
      ? [
          { organizer_org_id: { in: actor.orgIds } },
          // A venue owner operates every event in their building, whoever
          // created it, from the claim on — `eventPermissions` grants exactly
          // that, so the list shows exactly that.
          ...(user.role === "venue_owner" ? await claimedVenueEventsWhere(actor.orgIds) : []),
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
     */
    { organizer_id: user.id, ...hostNotSuspended },
  ]
  return where
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
 * compare a column to a related row's column. No claim date on an owned venue
 * is bad data and opens nothing, as in the resolver.
 *
 * ponytail: one OR arm per owned venue. Fine for the handful an org owns; a
 * raw-SQL join on `venues.claimed_at` if an org ever owns hundreds.
 */
export async function claimedVenueEventsWhere(orgIds: string[]): Promise<Record<string, unknown>[]> {
  if (orgIds.length === 0) return []
  const venues = await db.venues.findMany({
    where: { owner_org_id: { in: orgIds } },
    select: { id: true, claimed_at: true },
  })
  return venues.flatMap((v) =>
    v.claimed_at ? [{ venue_id: v.id, start_time: { gte: v.claimed_at } }] : []
  )
}
