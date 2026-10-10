"use server"

import { Refusal } from "./refusal"
import { db } from "@/lib/db"
import { currentUser } from "@/lib/current-user"
import type { Prisma } from "@prisma/client"
import { activeMembership } from "@/lib/org-membership"
import { isUuid } from "@/lib/api-input"
import { idForViewer } from "@/lib/room-handle"

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
  // The role the database holds now (step 18): an admin sees the platform's log, everyone else their organisations'.
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")

  const isAdmin = user.role === "app_admin"

  /*
   * The tenant scope is an invariant, not a default.
   *
   * These used to be assignments onto one `where` object, and `filters.actorId`
   * wrote the same key the scope did -- so a caller-supplied actor id replaced
   * the membership scope outright and returned any user's history from any
   * company. Worse, `filters` is the argument to a `"use server"` export and is
   * therefore attacker-controlled JSON however it is typed: `{ not: null }`
   * reaches Prisma as an operator rather than an id and unscopes the query
   * completely, returning the platform-wide audit trail with other owners'
   * names and email addresses in it.
   *
   * Collecting the conditions into `AND` means a filter can only ever narrow.
   * The `typeof` guards keep an object from becoming an operator; applied to
   * all three string filters, since only `actorId` was load-bearing today and
   * that is not a property worth relying on.
   */
  const and: Prisma.audit_logsWhereInput[] = []

  if (!isAdmin) {
    // An org admin auditing their own company must not be able to read another
    // company's suspensions out of the same table.
    const myOrgs = await db.organisation_members.findMany({
      where: { user_id: user.id, ...activeMembership },
      select: { org_id: true, role: true },
    })
    const manageable = myOrgs.filter((m) => m.role === "owner" || m.role === "admin")
    if (manageable.length === 0) throw new Refusal("Forbidden")

    /*
     * The rows that belong to these organisations (step 18, M3): `org_id`, the
     * organisation whose data the action changed, written with the row
     * (lib/audit-log.ts) and backfilled for the rows from before it. Whoever
     * acted — a member, one who has since left, a Blend'n admin. The rule used
     * to be "written by one of our members", which put a shared member's work
     * for their other organisation in this log, and dropped the history of
     * anyone who left. A row with no organisation is the platform's alone.
     */
    and.push({ org_id: { in: manageable.map((m) => m.org_id) } })
  }

  // The dropdown lists every action in scope, not only the filtered one (SCRUM-462).
  const scopeOnly: Prisma.audit_logsWhereInput = and.length ? { AND: [...and] } : {}

  if (typeof filters.action === "string") and.push({ action: filters.action })
  if (typeof filters.actorId === "string") and.push({ user_id: filters.actorId })
  if (typeof filters.resource === "string") and.push({ resource: filters.resource })
  if (filters.from instanceof Date || filters.to instanceof Date) {
    and.push({
      created_at: {
        ...(filters.from instanceof Date ? { gte: filters.from } : {}),
        ...(filters.to instanceof Date ? { lt: filters.to } : {}),
      },
    })
  }

  const where: Prisma.audit_logsWhereInput = and.length ? { AND: and } : {}

  const [rows, total, actionGroups] = await Promise.all([
    db.audit_logs.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: PAGE_SIZE,
    }),
    db.audit_logs.count({ where }),
    db.audit_logs.groupBy({ by: ["action"], where: scopeOnly, _count: { action: true } }),
  ])

  // One query for the actors rather than a join per row; `user_id` is nullable
  // because some entries are written by unauthenticated flows (an application
  // submitted at /apply has no account yet).
  const actorIds = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id))]
  const actors = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true, role: true },
      })
    : []
  /*
   * A Blend'n admin's act on an organisation's data is in that organisation's
   * log now (M3) — as the platform, not as a person: an organisation reads that
   * Blend'n decided its claim, not a staff member's name and address.
   */
  const actorMap = new Map(
    actors.map((a) => [
      a.id,
      !isAdmin && a.role === "app_admin" ? { id: "blendn", name: "Blend'n", email: "" } : { id: a.id, name: a.name, email: a.email },
    ])
  )

  return {
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      resource: r.resource,
      resourceId: isAdmin ? r.resource_id : hostResourceId(user.id, r),
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

/**
 * A row's resource id as an organisation's owner or admin may see it.
 *
 * A chat member's row is keyed on the attendee's ACCOUNT id — the ban, mute
 * and their reversals write it as `resource_id`. That id is the same in every
 * room, so a host reading the log across several nights joined the people they
 * had moderated into one history (SCRUM-517). They see this room's handle
 * instead, the one the Chat tab showed them; the admin keeps the account id,
 * and the stored row is unchanged, so this covers rows written before it too.
 * Without the event to scope a handle, nothing.
 */
function hostResourceId(
  viewerId: string,
  row: { resource: string; resource_id: string | null; details: unknown }
): string | null {
  if (row.resource !== "chat_group_member" || !row.resource_id) return row.resource_id
  const eventId = (row.details as { eventId?: unknown } | null)?.eventId
  return typeof eventId === "string" && isUuid(eventId) ? idForViewer(viewerId, eventId, row.resource_id) : null
}
