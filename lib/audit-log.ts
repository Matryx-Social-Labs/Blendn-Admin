import { clientIpFrom } from "@/lib/client-ip"
import { logger } from "./logger"
import { db } from "./db"
import { Prisma } from "@prisma/client"
import { activeMembership, HOME_ORG_ORDER } from "./org-membership"

export interface AuditLogEntry {
  userId?: string
  action: string
  resource: string
  resourceId?: string
  details?: Prisma.InputJsonValue
  ipAddress?: string
  /**
   * The organisation the row belongs to, when the caller already knows it
   * (billing, by its subject). Left out, it is derived from the resource
   * (`ORG_RESOURCES`); `null` says the row is the platform's alone.
   */
  orgId?: string | null
}

type Client = Prisma.TransactionClient

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The id a resolver reads, if the entry has a usable one. */
const idOf = (e: AuditLogEntry) => (e.resourceId && UUID.test(e.resourceId) ? e.resourceId : null)
const detail = (e: AuditLogEntry, key: string): string | null => {
  const d = e.details as Record<string, unknown> | undefined
  const v = d && typeof d === "object" ? d[key] : undefined
  return typeof v === "string" && UUID.test(v) ? v : null
}

/** What a resolver must be handed: the resource's id, the room's event in the details, or the actor. */
type Need = "id" | "eventId" | "actor"

/** Whether the entry carries what its kind needs, checked before any lookup. */
function hasWhatItNeeds(entry: AuditLogEntry, need: Need): boolean {
  if (need === "id") return idOf(entry) !== null
  if (need === "eventId") return detail(entry, "eventId") !== null
  return !!entry.userId
}

/** What a resolver says: the organisation (null: the resource has none — a curated event, an unclaimed venue), or that it could not tell. */
type Resolved = { org: string | null } | "unresolvable"

/**
 * Of a placement's two organisations, the one this actor acts for: the
 * brand's owner when they are one of its members, otherwise the host — so an
 * admin's action on a placement is the host's to read.
 */
async function sideOf(client: Client, actor: string | undefined, host: string | null, brand: string | null): Promise<string | null> {
  if (actor && brand) {
    const member = await client.organisation_members.findFirst({
      where: { user_id: actor, org_id: brand, ...activeMembership },
      select: { id: true },
    })
    if (member) return brand
  }
  return host
}

async function eventOrg(client: Client, eventId: string | null | undefined): Promise<string | null> {
  if (!eventId) return null
  const e = await client.events.findUnique({ where: { id: eventId }, select: { organizer_org_id: true } })
  return e?.organizer_org_id ?? null
}

/**
 * Every resource kind an organisation's log shows, and how a row about one
 * finds its organisation (step 18 security review, M3): the organisation
 * whose data changed — whoever changed it, a member who has since left or a
 * Blend'n admin included. A kind listed here MUST resolve: an entry that
 * cannot (no usable id) is an error, never a row any organisation reads.
 * A kind not listed is the platform's alone (accounts, leads, categories,
 * amenities, reports about people).
 */
export const ORG_RESOURCES = {
  organisation: { needs: "id", resolve: async (_c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    return id ? { org: id } : "unresolvable"
  } },
  event: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    return id ? { org: await eventOrg(c, id) } : "unresolvable"
  } },
  venue: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const v = await c.venues.findUnique({ where: { id }, select: { owner_org_id: true, created_by_org_id: true } })
    return { org: v?.owner_org_id ?? v?.created_by_org_id ?? null }
  } },
  sponsors: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const b = await c.sponsors.findUnique({ where: { id }, select: { org_id: true } })
    return { org: b?.org_id ?? null }
  } },
  event_sponsors: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const p = await c.event_sponsors.findUnique({
      where: { id },
      select: { event: { select: { organizer_org_id: true } }, sponsor: { select: { org_id: true } } },
    })
    return { org: p ? await sideOf(c, e.userId, p.event.organizer_org_id, p.sponsor.org_id) : null }
  } },
  sponsored_creatives: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const cr = await c.sponsored_creatives.findUnique({
      where: { id },
      select: { message: { select: { event: { select: { organizer_org_id: true } }, sponsor: { select: { org_id: true } } } } },
    })
    return { org: cr ? await sideOf(c, e.userId, cr.message.event.organizer_org_id, cr.message.sponsor?.org_id ?? null) : null }
  } },
  placement_charges: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const ch = await c.placement_charges.findUnique({ where: { id }, select: { placement_id: true } })
    if (!ch) return { org: null }
    const p = await c.event_sponsors.findUnique({
      where: { id: ch.placement_id },
      select: { event: { select: { organizer_org_id: true } }, sponsor: { select: { org_id: true } } },
    })
    // The bill is the brand's, and nobody else's: a host never reads what a
    // brand was charged, and a brand nobody owns leaves it the platform's.
    return { org: p?.sponsor.org_id ?? null }
  } },
  moderation_flag: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const f = await c.moderation_flags.findUnique({ where: { id }, select: { chat_group_id: true } })
    if (!f) return { org: null }
    const g = await c.chat_groups.findUnique({ where: { id: f.chat_group_id }, select: { event: { select: { organizer_org_id: true } } } })
    return { org: g?.event?.organizer_org_id ?? null }
  } },
  chat_group_member: { needs: "eventId", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    // The member's id is the resource; the room's event is in the details.
    const eventId = detail(e, "eventId")
    return eventId ? { org: await eventOrg(c, eventId) } : "unresolvable"
  } },
  chat_polls: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const poll = await c.chat_polls.findUnique({ where: { id }, select: { message: { select: { chat_group_id: true } } } })
    if (!poll) return { org: null }
    const g = await c.chat_groups.findUnique({ where: { id: poll.message.chat_group_id }, select: { event: { select: { organizer_org_id: true } } } })
    return { org: g?.event?.organizer_org_id ?? null }
  } },
  event_feedback: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const f = await c.event_feedback.findUnique({ where: { id }, select: { event_id: true } })
    return { org: await eventOrg(c, f?.event_id) }
  } },
  event_claim: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const claim = await c.event_claims.findUnique({ where: { id }, select: { org_id: true } })
    return { org: claim?.org_id ?? null }
  } },
  organiser_onboarding_request: { needs: "id", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    const id = idOf(e)
    if (!id) return "unresolvable"
    const r = await c.organiser_onboarding_requests.findUnique({ where: { id }, select: { org_id: true } })
    return { org: r?.org_id ?? null }
  } },
  report: { needs: "actor", resolve: async (c: Client, e: AuditLogEntry): Promise<Resolved> => {
    // An export is its exporter's organisation's: the one they act for (their home).
    if (!e.userId) return "unresolvable"
    const home = await c.organisation_members.findFirst({
      where: { user_id: e.userId, ...activeMembership },
      orderBy: HOME_ORG_ORDER,
      select: { org_id: true },
    })
    return { org: home?.org_id ?? null }
  } },
} satisfies Record<string, { needs: Need; resolve: (c: Client, e: AuditLogEntry) => Promise<Resolved> }>

export type OrgResourceKind = keyof typeof ORG_RESOURCES

const isOrgResource = (resource: string): resource is OrgResourceKind => Object.hasOwn(ORG_RESOURCES, resource)

/** A row about an organisation's resource that could not say which organisation. */
export class UnattributedAuditError extends Error {}

/**
 * Tests run with this on: an organisation's row that cannot be attributed is
 * a failed write, so a call site that drops the id fails its own suite. In
 * production the row is still written — an audit trail with a hole is worse —
 * but as the platform's alone, and the error is logged.
 */
const strictAttribution = () => process.env.NODE_ENV === "test"

function unattributed(entry: AuditLogEntry, why: string): null {
  const message = `Audit row "${entry.action}" on ${entry.resource} cannot be attributed to an organisation: ${why}`
  if (strictAttribution()) throw new UnattributedAuditError(message)
  logger.error(message, { action: entry.action, resource: entry.resource, resourceId: entry.resourceId ?? null })
  return null
}

/**
 * The organisation a row belongs to. Never "everyone": a row that cannot be
 * attributed is written with no organisation, which only the platform reads.
 */
async function orgForEntry(client: Client, entry: AuditLogEntry): Promise<string | null> {
  if (entry.orgId !== undefined) return entry.orgId
  if (!isOrgResource(entry.resource)) return null
  const kind = ORG_RESOURCES[entry.resource]
  if (!hasWhatItNeeds(entry, kind.needs)) return unattributed(entry, `it carries no ${kind.needs}`)
  let resolved: Resolved
  try {
    resolved = await kind.resolve(client, entry)
  } catch (error) {
    return unattributed(entry, `the lookup failed (${String(error)})`)
  }
  if (resolved === "unresolvable") return unattributed(entry, "no usable resource id")
  return resolved.org
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
 * Fire-and-forget — does not throw on failure. An attribution failure still
 * writes the row, as the platform's (`orgForEntry`); in tests it is thrown
 * from here, synchronously where it can be.
 */
export function auditLog(entry: AuditLogEntry): void {
  // The part of attribution that needs no database, here and synchronously, so
  // in tests a call site that drops what its kind needs fails at the call.
  if (entry.orgId === undefined && isOrgResource(entry.resource) && !hasWhatItNeeds(entry, ORG_RESOURCES[entry.resource].needs)) {
    unattributed(entry, `it carries no ${ORG_RESOURCES[entry.resource].needs}`)
  }
  orgForEntry(db, entry)
    .catch((error) => {
      logger.error("Audit attribution failed", { error: String(error), action: entry.action })
      return null
    })
    .then((orgId) => db.audit_logs.create({ data: rowFor(entry, orgId) }))
    .catch((err) => {
      logger.error("Audit log write failed", { error: String(err) })
    })
}

/**
 * Write an audit row inside the caller's transaction, so the decision and its
 * record commit together or not at all (step 18: a decision that raced and
 * lost writes neither). Unlike `auditLog` this throws: a decision whose record
 * cannot be written is not made. Every in-transaction writer — decisions,
 * webhooks, grants, charges — comes through here, so attribution is one rule
 * (`audit-writes-boundary.test.ts`).
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
