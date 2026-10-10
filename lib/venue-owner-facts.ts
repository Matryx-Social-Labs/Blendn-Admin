import { db } from "@/lib/db"
import { HOME_ORG_ORDER } from "@/lib/org-membership"

export interface VenueOwnerFacts {
  /** The home organisation's name (the oldest membership), or null for none. */
  org: string | null
  /** Venues owned by any organisation the person belongs to. */
  venues: number
  /** Venue claims this person filed that still wait on a decision. */
  pendingClaims: number
}

const NONE: VenueOwnerFacts = { org: null, venues: 0, pendingClaims: 0 }

/**
 * What the admin's venue-owner list says beside each account: the organisation,
 * how many venues it holds, and whether a claim is waiting.
 *
 * A venue owner is an account, and the venues belong to an organisation
 * (`venues.owner_org_id`), so "how many venues" is read through membership —
 * never through `venues.owner_id`, which has no writer. A claim is the
 * person's own (`venue_claims.filed_by`): "claim pending" on a row is the
 * account somebody has to answer.
 *
 * Plain, not `"use server"`: an exported server action is an endpoint any
 * signed-in user could call. The page checks the session is an admin first.
 */
export async function venueOwnerFacts(userIds: string[]): Promise<Record<string, VenueOwnerFacts>> {
  if (userIds.length === 0) return {}

  const [memberships, claims] = await Promise.all([
    db.organisation_members.findMany({
      where: { user_id: { in: userIds } },
      // Oldest first, so the first membership met per person is their home.
      orderBy: HOME_ORG_ORDER,
      select: { user_id: true, org_id: true, org: { select: { display_name: true } } },
    }),
    db.venue_claims.groupBy({
      by: ["filed_by"],
      where: { filed_by: { in: userIds }, status: "pending" },
      _count: { _all: true },
    }),
  ])

  const orgIds = [...new Set(memberships.map((m) => m.org_id))]
  const venues =
    orgIds.length === 0
      ? []
      : await db.venues.groupBy({
          by: ["owner_org_id"],
          where: { owner_org_id: { in: orgIds }, deleted_at: null },
          _count: { _all: true },
        })
  const venuesByOrg = new Map(venues.map((v) => [v.owner_org_id, v._count._all]))
  const claimsBy = new Map(claims.map((c) => [c.filed_by, c._count._all]))

  return Object.fromEntries(
    userIds.map((id) => {
      const mine = memberships.filter((m) => m.user_id === id)
      return [
        id,
        {
          ...NONE,
          org: mine[0]?.org.display_name ?? null,
          venues: mine.reduce((sum, m) => sum + (venuesByOrg.get(m.org_id) ?? 0), 0),
          pendingClaims: claimsBy.get(id) ?? 0,
        },
      ]
    })
  )
}
