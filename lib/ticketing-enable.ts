import type { Prisma, user_role } from "@prisma/client"

import { isUuid } from "./api-input"
import { auditInTx } from "./audit-log"
import { cityCatalogue, cityFor } from "./cities"
import { db } from "./db"
import { hasEntitlement } from "./entitlements"
import { realEventsWhere } from "./event-kind"
import { ticketingOn } from "./env"
import { ORGANIZER_TICKETING_TERMS } from "./legal-acceptance"
import { actorFor } from "./org-membership"
import { eventPermissionSelect, eventPermissions, type PermissionActor } from "./rbac"
import { feeRuleFor, feeScheduleFromMarket, type FeeRule, type FeeSchedule, type MarketFeeRow } from "./ticket-fees"

/**
 * Turn native ticket selling on for an event (SCRUM-1010, security H4).
 *
 * The one writer of an event's price: its fee snapshot, its rule and when it
 * was decided. `reserveTickets` reads all three from the row, so nothing a
 * buyer sends, and nothing a caller resolves for itself, can price an order.
 *
 * In one transaction, with the event and its organisation locked:
 *
 * 1. The actor may edit the event (`eventPermissions` on `actorFor`, so the
 *    role and memberships are the database's, organisation-shaped).
 * 2. The organisation's acceptance of the organizer ticketing terms in force
 *    is the version current now (database 13).
 * 3. The market is the event's city's (`cities.market_code`, decision §4.2),
 *    and must sell natively; its rates are snapshotted.
 * 4. The rule is derived here: founding while the organisation has had fewer
 *    than three ticketed events and the offer is open, else Pro if it has paid
 *    Analytics (or the event's venue, owned by it, has Venue Pro), else
 *    standard. The organisation row is locked, so two events turned on at once
 *    cannot both be its third.
 *
 * Once on, it stays decided: turning on again is refused, so a later rate
 * change never reprices an event already selling.
 */

export type EnableRefusal =
  | "ticketing_off"
  | "not_found"
  | "not_authorized"
  | "no_organization"
  | "terms_not_accepted"
  | "market_not_native"
  | "already_enabled"

export type EnableResult =
  | { ok: true; rule: FeeRule; schedule: FeeSchedule; enabledAt: Date }
  | { ok: false; reason: EnableRefusal }

class Refused extends Error {
  constructor(readonly reason: EnableRefusal) {
    super(reason)
  }
}

const TX = { maxWait: 10_000, timeout: 15_000 }

async function lockedEvent(tx: Prisma.TransactionClient, eventId: string) {
  await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid AND kind = 'event' FOR UPDATE`
  return tx.events.findUnique({
    where: { id: eventId },
    select: { ...eventPermissionSelect, deleted_at: true, city: true, venue_id: true, ticketing_enabled_at: true },
  })
}

async function termsAccepted(tx: Prisma.TransactionClient, orgId: string): Promise<boolean> {
  const latest = await tx.legal_acceptances.findFirst({
    where: { org_id: orgId, document_key: ORGANIZER_TICKETING_TERMS.key },
    orderBy: [{ accepted_at: "desc" }, { id: "desc" }],
    select: { version: true },
  })
  return latest?.version === ORGANIZER_TICKETING_TERMS.version
}

/** Paid Analytics for the organisation, or Venue Pro on the event's venue when the organisation owns it. */
async function onPro(tx: Prisma.TransactionClient, orgId: string, venueId: string | null, venueOwnerOrgId: string | null, now: Date) {
  if (await hasEntitlement({ kind: "org", id: orgId }, "analytics", {}, now, tx)) return true
  return venueId !== null && venueOwnerOrgId === orgId && hasEntitlement({ kind: "venue", id: venueId }, "venue_pro", {}, now, tx)
}

async function enable(tx: Prisma.TransactionClient, eventId: string, actor: PermissionActor, marketOf: (city: string | null) => string | null) {
  const now = new Date()
  const event = await lockedEvent(tx, eventId)
  if (!event || event.deleted_at || event.kind !== "event") throw new Refused("not_found")
  if (!eventPermissions(actor, event).canEdit) throw new Refused("not_authorized")
  if (event.ticketing_enabled_at) throw new Refused("already_enabled")
  const orgId = event.organizer_org_id
  if (!orgId) throw new Refused("no_organization")

  // Serialises this organisation's turn-ons, so the founding count below is exact.
  await tx.$queryRaw`SELECT id FROM organisations WHERE id = ${orgId}::uuid FOR UPDATE`
  if (!(await termsAccepted(tx, orgId))) throw new Refused("terms_not_accepted")

  const marketCode = marketOf(event.city)
  const market = marketCode ? await tx.markets.findUnique({ where: { code: marketCode } }) : null
  if (!market || market.ticketing_mode !== "native") throw new Refused("market_not_native")
  const schedule = feeScheduleFromMarket(market as MarketFeeRow, now)

  // Every event that was ever turned on counts, deleted ones too: deleting one does not hand the offer back.
  const ticketedEventsBefore = await tx.events.count({ where: { organizer_org_id: orgId, ticketing_enabled_at: { not: null }, ...realEventsWhere } })
  const pro = await onPro(tx, orgId, event.venue_id, event.venue?.owner_org_id ?? null, now)
  const rule = feeRuleFor({ pro, founding: { ticketedEventsBefore, enabledAt: now } })

  await tx.events.update({
    where: { id: eventId },
    data: {
      ticketing_mode: "native",
      ticket_fee_schedule: schedule as unknown as Prisma.InputJsonObject,
      ticket_fee_rule: rule,
      ticketing_enabled_at: now,
    },
  })
  await auditInTx(tx, {
    userId: actor.id,
    action: "ticketing.enable",
    resource: "event",
    resourceId: eventId,
    orgId,
    details: { rule, market: schedule.market, ticketedEventsBefore, pro },
  })
  return { ok: true as const, rule, schedule, enabledAt: now }
}

export async function enableTicketing(eventId: string, user: { id: string; role: user_role }): Promise<EnableResult> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!isUuid(eventId)) return { ok: false, reason: "not_found" }
  // Read before the transaction, so no lock waits on them: the role and memberships are the database's.
  const actor = await actorFor(user)
  const catalogue = await cityCatalogue()
  const marketOf = (city: string | null) => cityFor(catalogue, city)?.country ?? null
  try {
    return await db.$transaction((tx) => enable(tx, eventId, actor, marketOf), TX)
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason }
    throw error
  }
}
