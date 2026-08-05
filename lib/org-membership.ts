import type { user_role } from "@prisma/client"

// Relative: reachable from server.ts via socket-ops-auth. See v0.12.1.
import { db } from "./db"
import type { PermissionActor } from "./rbac"

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
