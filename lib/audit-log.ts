import { clientIpFrom } from "@/lib/client-ip"
import { logger } from "./logger"
import { db } from "./db"
import { Prisma } from "@prisma/client"
import { activeMembership } from "./org-membership"

interface AuditLogEntry {
  userId?: string
  action: string
  resource: string
  resourceId?: string
  details?: Prisma.InputJsonValue
  ipAddress?: string
  /**
   * The organisation the row belongs to, when the caller knows it. Left out,
   * it is derived (`orgForEntry`); `null` says the row is the platform's alone.
   */
  orgId?: string | null
}

type AuditClient = Pick<Prisma.TransactionClient, "audit_logs" | "events" | "venues" | "sponsors" | "event_sponsors" | "sponsored_creatives" | "moderation_flags" | "chat_groups" | "organisation_members">

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The organisations that own a row's resource, for the kinds an organisation's
 * own log shows (step 18, M3): its events, venues, brands, placements,
 * creatives, room flags, and the organisation itself. A placement or creative
 * has two — the event's host and the brand's owner — and the row goes to
 * whichever the actor acts for. Any other resource belongs to nobody's log
 * but the platform's.
 */
async function ownersOf(client: AuditClient, resource: string, id: string): Promise<string[]> {
  const present = (...ids: Array<string | null | undefined>) => ids.filter((x): x is string => !!x)
  switch (resource) {
    case "organisation":
      return [id]
    case "event": {
      const e = await client.events.findUnique({ where: { id }, select: { organizer_org_id: true } })
      return present(e?.organizer_org_id)
    }
    case "venue": {
      const v = await client.venues.findUnique({ where: { id }, select: { owner_org_id: true, created_by_org_id: true } })
      return present(v?.owner_org_id ?? v?.created_by_org_id)
    }
    case "sponsors": {
      const b = await client.sponsors.findUnique({ where: { id }, select: { org_id: true } })
      return present(b?.org_id)
    }
    case "event_sponsors": {
      const p = await client.event_sponsors.findUnique({
        where: { id },
        select: { event: { select: { organizer_org_id: true } }, sponsor: { select: { org_id: true } } },
      })
      return present(p?.event.organizer_org_id, p?.sponsor.org_id)
    }
    case "sponsored_creatives": {
      const c = await client.sponsored_creatives.findUnique({
        where: { id },
        select: { message: { select: { event: { select: { organizer_org_id: true } }, sponsor: { select: { org_id: true } } } } },
      })
      return present(c?.message.event.organizer_org_id, c?.message.sponsor?.org_id)
    }
    case "moderation_flag": {
      const f = await client.moderation_flags.findUnique({ where: { id }, select: { chat_group_id: true } })
      if (!f) return []
      const g = await client.chat_groups.findUnique({
        where: { id: f.chat_group_id },
        select: { event: { select: { organizer_org_id: true } } },
      })
      return present(g?.event?.organizer_org_id)
    }
    default:
      return []
  }
}

/**
 * The organisation an audit row belongs to: the given one, or the owner of its
 * resource of which the actor is a member — "an action on our resource by one
 * of us". An admin acting on an organisation's venue, or a member of two
 * organisations acting for the other one, writes a row this organisation does
 * not read.
 */
async function orgForEntry(client: AuditClient, entry: AuditLogEntry): Promise<string | null> {
  if (entry.orgId !== undefined) return entry.orgId
  if (!entry.userId || !entry.resourceId || !UUID.test(entry.resourceId)) return null
  const owners = await ownersOf(client, entry.resource, entry.resourceId)
  if (owners.length === 0) return null
  const member = await client.organisation_members.findFirst({
    where: { user_id: entry.userId, org_id: { in: owners }, ...activeMembership },
    orderBy: { created_at: "asc" },
    select: { org_id: true },
  })
  return member?.org_id ?? null
}

function rowFor(entry: AuditLogEntry, orgId: string | null) {
  return {
    user_id: entry.userId ?? null,
    action: entry.action,
    resource: entry.resource,
    resource_id: entry.resourceId ?? null,
    /*
     * Conditional spread, not `?? undefined`. With `strictUndefinedChecks`
     * on, an explicit undefined here made every audit write WITHOUT
     * details throw — `signout`, among others — and the catch below
     * logged it and moved on, so the accountability record had holes
     * nobody was told about. Seen in the dev log as "Audit log write
     * failed"; the ratchet had missed it because this call is split
     * across a newline.
     */
    ...(entry.details !== undefined && { details: entry.details }),
    ip_address: entry.ipAddress ?? null,
    org_id: orgId,
  }
}

/**
 * Log a sensitive operation for audit purposes.
 * Fire-and-forget — does not throw on failure.
 */
export function auditLog(entry: AuditLogEntry): void {
  orgForEntry(db, entry)
    .then((orgId) => db.audit_logs.create({ data: rowFor(entry, orgId) }))
    .catch((err) => {
      logger.error("Audit log write failed", { error: String(err) })
    })
}

/**
 * Write an audit row inside the caller's transaction, so the decision and its
 * record commit together or not at all (step 18: a decision that raced and
 * lost writes neither). Unlike `auditLog` this throws: a decision whose record
 * cannot be written is not made.
 */
export async function auditInTx(tx: Prisma.TransactionClient, entry: AuditLogEntry): Promise<void> {
  await tx.audit_logs.create({ data: rowFor(entry, await orgForEntry(tx, entry)) })
}

/**
 * The address written onto an audit row. Same reader as the rate limiters —
 * see lib/client-ip.ts for what Railway's edge actually sends. Until
 * SCRUM-195 this recorded the edge node (152.233.x), which identified nobody.
 */
export function getRequestIp(request: Request): string {
  return clientIpFrom(request.headers)
}
