import type { user_role } from "@prisma/client"

// Relative: reachable from server.ts via socket-ops-auth. See v0.12.1.
import { db } from "./db"
import type { PermissionActor, SponsorGrant } from "./rbac"

/**
 * Load an actor with the organisations they belong to.
 *
 * `eventPermissions` is pure and takes memberships as data, so every call site
 * has to supply them. This is the one place that reads them, which keeps the
 * query identical everywhere — a route that fetched memberships slightly
 * differently would produce a different answer to the same authorization
 * question.
 *
 * Admins short-circuit: they bypass org checks entirely, so loading their
 * memberships would be a query whose result is never read.
 */
export async function actorFor(user: {
  id: string
  role: user_role
}): Promise<PermissionActor> {
  if (user.role === "app_admin") return { id: user.id, role: user.role, orgIds: [] }

  const memberships = await db.organisation_members.findMany({
    where: { user_id: user.id },
    select: { org_id: true },
  })

  return { id: user.id, role: user.role, orgIds: memberships.map((m) => m.org_id) }
}

/**
 * Whether any organisation this actor belongs to may sell placement.
 *
 * A separate query rather than a field on `PermissionActor`, because the flag
 * is only ever needed on the one route that writes a sponsored message —
 * loading it for every permission check would put a join on the hot path of
 * every event read to answer a question almost nobody asks.
 *
 * `app_admin` short-circuits to true and never queries: `actorFor` gives them
 * an empty `orgIds`, so the `some` below would be vacuously false and an admin
 * would be refused their own platform's placement.
 */

/**
 * Resolve the ONE organisation acting, with both of its entitlements together.
 *
 * ## The bug this exists to make unrepresentable
 *
 * `maySponsorFor` above answers "does **any** org you belong to hold the flag".
 * A `placesAtEvent` written the same way answers "does **any** org you belong to
 * have a placement". Pass both to `canBroadcast` as separate booleans and a
 * person who is staff at Org A (flag, no placement) and Org B (placement, no
 * flag) satisfies the check while neither organisation is entitled to send.
 *
 * One query, one row, both fields. There is no arrangement of the result that
 * mixes two organisations.
 *
 * Returns `null` when no org of this actor's both holds the flag and has an
 * approved placement here — which `canBroadcast` treats as a refusal.
 *
 * `app_admin` deliberately gets no grant: `canBroadcast` short-circuits them
 * before this is consulted, and manufacturing a synthetic org id for them would
 * put a lie in the audit trail.
 */
export async function resolveSponsorGrant(
  actor: { role: user_role; orgIds: string[] },
  eventId: string
): Promise<SponsorGrant | null> {
  if (actor.role === "app_admin") return null
  if (actor.orgIds.length === 0) return null

  const org = await db.organisations.findFirst({
    where: {
      id: { in: actor.orgIds },
      may_sponsor: true,
      // The SAME organisation must also hold the placement. Expressed as a
      // relation filter rather than a second query precisely so the two facts
      // cannot come from two different rows.
      sponsors: {
        some: {
          deleted_at: null,
          merged_into: null,
          placements: { some: { event_id: eventId, status: "approved" } },
        },
      },
    },
    select: { id: true },
  })

  if (!org) return null
  return { orgId: org.id, maySponsor: true, placesAtEvent: true }
}

/**
 * Which of these events this actor's orgs place at, in one query.
 *
 * `resolveSponsorGrant` is correct for one event and wrong in a loop — a
 * sponsor dashboard listing forty placements would issue forty queries. This is
 * the list-context answer; it deliberately does NOT return a grant, because a
 * grant is an authorization decision about one event and this is a filter.
 */
export async function placesAtEventBulk(
  actor: { role: user_role; orgIds: string[] },
  eventIds: string[]
): Promise<Set<string>> {
  if (actor.orgIds.length === 0 || eventIds.length === 0) return new Set()

  const rows = await db.event_sponsors.findMany({
    where: {
      event_id: { in: eventIds },
      status: "approved",
      sponsor: { org_id: { in: actor.orgIds }, deleted_at: null, merged_into: null },
    },
    select: { event_id: true },
    distinct: ["event_id"],
  })
  return new Set(rows.map((r) => r.event_id))
}
