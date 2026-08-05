"use server"

import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import type { Prisma } from "@prisma/client"

/**
 * Reading the audit log.
 *
 * `audit_logs` is written by every sensitive action in the product — role
 * changes, suspensions, moderation decisions, invite domain-overrides, org
 * approvals, password changes — and until now **nothing ever read it back**.
 * Accountability data nobody can see is not accountability; it is disk usage.
 *
 * Two audiences, one table:
 *
 *   - **platform admin** sees everything
 *   - **org owner/admin** sees only what their own members did, scoped by
 *     membership. Without that scoping this would be a way to read every other
 *     company's operations out of a shared table.
 */

export interface AuditEntry {
  id: string
  action: string
  resource: string
  resourceId: string | null
  createdAt: Date
  actor: { id: string; name: string | null; email: string } | null
  details: Prisma.JsonValue
  ipAddress: string | null
}

export interface AuditFilters {
  action?: string
  actorId?: string
  resource?: string
  from?: Date
  to?: Date
}

export interface AuditPage {
  entries: AuditEntry[]
  /** Distinct actions present, for the filter dropdown. */
  actions: string[]
  total: number
  /** True when the viewer is seeing only their own organisation's activity. */
  scopedToOrg: boolean
}

const PAGE_SIZE = 100

export async function getAuditLog(filters: AuditFilters = {}): Promise<AuditPage> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const isAdmin = session.user.role === "app_admin"

  const where: Prisma.audit_logsWhereInput = {}

  if (!isAdmin) {
    // Scope to the actors who are members of the viewer's organisations. An
    // org admin auditing their own company must not be able to read another
    // company's suspensions out of the same table.
    const myOrgs = await db.organisation_members.findMany({
      where: { user_id: session.user.id },
      select: { org_id: true, role: true },
    })
    const manageable = myOrgs.filter((m) => m.role === "owner" || m.role === "admin")
    if (manageable.length === 0) throw new Error("Forbidden")

    const colleagues = await db.organisation_members.findMany({
      where: { org_id: { in: manageable.map((m) => m.org_id) } },
      select: { user_id: true },
    })
    where.user_id = { in: colleagues.map((c) => c.user_id) }
  }

  if (filters.action) where.action = filters.action
  if (filters.actorId) where.user_id = filters.actorId
  if (filters.resource) where.resource = filters.resource
  if (filters.from || filters.to) {
    where.created_at = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lt: filters.to } : {}),
    }
  }

  const [rows, total, actionGroups] = await Promise.all([
    db.audit_logs.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: PAGE_SIZE,
    }),
    db.audit_logs.count({ where }),
    db.audit_logs.groupBy({ by: ["action"], where, _count: { action: true } }),
  ])

  // One query for the actors rather than a join per row; `user_id` is nullable
  // because some entries are written by unauthenticated flows (an application
  // submitted at /apply has no account yet).
  const actorIds = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id))]
  const actors = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : []
  const actorMap = new Map(actors.map((a) => [a.id, a]))

  return {
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      resource: r.resource,
      resourceId: r.resource_id,
      createdAt: r.created_at,
      actor: r.user_id ? (actorMap.get(r.user_id) ?? null) : null,
      details: r.details,
      // IP is admin-only. An org admin seeing a colleague's home IP address is
      // more than "who changed what", and it is not theirs to have.
      ipAddress: isAdmin ? r.ip_address : null,
    })),
    actions: actionGroups.map((g) => g.action).sort(),
    total,
    scopedToOrg: !isAdmin,
  }
}
