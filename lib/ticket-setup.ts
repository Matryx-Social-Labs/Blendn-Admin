import type { markets, ticket_refund_policy, user_role } from "@prisma/client"

import { isUuid } from "./api-input"
import { auditLog } from "./audit-log"
import { cityCatalogue, cityFor } from "./cities"
import { db } from "./db"
import { hasEntitlement } from "./entitlements"
import { ticketingOn } from "./env"
import { realEventsWhere } from "./event-kind"
import { httpsUrl } from "./https-url"
import { latestLegalAcceptance, ORGANIZER_TICKETING_TERMS, recordLegalAcceptance, type AcceptanceRefusal } from "./legal-acceptance"
import { readOrganizerTicketingTerms } from "./legal-html"
import { actorFor } from "./org-membership"
import { payoutStatus } from "./payout-status"
import { eventPermissionSelect, eventPermissions } from "./rbac"
import { feeRuleFor, feeScheduleFromMarket, ticketFees, type FeeRule, type MarketFeeRow } from "./ticket-fees"
import { externalSiteOf } from "./ticket-views"
import { enableTicketing, type EnableRefusal } from "./ticketing-enable"

/**
 * Turning an event's tickets on from the Tickets tab (SCRUM-1014), and
 * Canada's link out. The money rules are `enableTicketing`'s and the
 * acceptance record is `recordLegalAcceptance`'s; this is the order they run
 * in, and the checks the dashboard makes first so nothing is recorded for a
 * turn-on that cannot happen.
 */

type User = { id: string; role: user_role }
const POLICIES: readonly ticket_refund_policy[] = ["none", "until_7d", "until_24h"]

/** The market an event's city is in, with its ticketing rates; null for a city in none (decision §4.2). */
export async function marketFor(city: string | null): Promise<markets | null> {
  const code = cityFor(await cityCatalogue(), city)?.country
  return code ? db.markets.findUnique({ where: { code } }) : null
}

/** Whether, and how, an event may sell here: its own mode once set, else its market's. Null while TICKETING is off. */
export async function ticketingModeFor(event: { kind: string; city: string | null; ticketing_mode: string }): Promise<"native" | "external" | null> {
  if (!ticketingOn() || event.kind !== "event") return null
  if (event.ticketing_mode === "native" || event.ticketing_mode === "external") return event.ticketing_mode
  const mode = (await marketFor(event.city))?.ticketing_mode
  return mode === "native" || mode === "external" ? mode : null
}

export interface FeePreview {
  rule: FeeRule
  /** The service-fee rate per slab under that rule, in bps: what the fees table shows. */
  slabs: Array<{ fromTicket: number; toTicket: number | null; bps: number; standardBps: number }>
  minFeeMinor: number
  taxBps: number
  taxLabel: string
  processingBps: number
  currency: string
  /** One ticket at `exampleMinor`, the first of the event: what the buyer pays on top. */
  exampleMinor: number
  exampleBookingFeeMinor: number
  ticketedEventsBefore: number
}

/**
 * The fees an event would sell at if it turned on now: the rule
 * `enableTicketing` would derive (founding, Pro on paid Analytics, else
 * standard) and its rates. A preview: the rule is fixed when it turns on.
 */
export async function feePreview(orgId: string, market: markets, exampleMinor: number, now: Date = new Date()): Promise<FeePreview> {
  const ticketedEventsBefore = await db.events.count({ where: { organizer_org_id: orgId, ticketing_enabled_at: { not: null }, ...realEventsWhere } })
  const pro = await hasEntitlement({ kind: "org", id: orgId }, "analytics", {}, now)
  const rule = feeRuleFor({ pro, founding: { ticketedEventsBefore, enabledAt: now } })
  const schedule = feeScheduleFromMarket(market as MarketFeeRow, now)
  const line = { ticketTypeId: "00000000-0000-0000-0000-000000000000", unitPriceMinor: exampleMinor, quantity: 1 }
  const example = ticketFees({ schedule, paidTicketsBefore: 0, lines: [line], rule, feesAbsorbed: false })
  const slabs = schedule.slabs.map((s, i) => {
    const next = schedule.slabs[i + 1]
    // The same per-slab rate the calculator charges a ticket in it.
    const at = ticketFees({ schedule, paidTicketsBefore: s.fromTicket - 1, lines: [{ ...line, unitPriceMinor: 1_000_000 }], rule, feesAbsorbed: false })
    return { fromTicket: s.fromTicket, toTicket: next ? next.fromTicket - 1 : null, bps: at.lines[0].segments[0].bps, standardBps: s.bps }
  })
  return {
    rule,
    slabs,
    minFeeMinor: schedule.minFeeMinor,
    taxBps: schedule.serviceTaxBps,
    taxLabel: market.ticket_tax_label,
    processingBps: schedule.processingBps,
    currency: schedule.currency,
    exampleMinor,
    exampleBookingFeeMinor: example.totals.bookingFeeMinor,
    ticketedEventsBefore,
  }
}

export type TurnOnRefusal = EnableRefusal | AcceptanceRefusal | "terms_changed" | "invalid"

export interface TurnOnInput {
  /** The hash the page rendered with the terms. Compared with the server's own, never recorded. */
  documentSha256: string
  refundPolicy: string
  feesAbsorbed: boolean
  ip?: string | null
  userAgent?: string | null
}

/**
 * Accept the terms (if the organization has not accepted the version in
 * force) and turn native selling on.
 *
 * The hash recorded is the server's, of the text it serves now
 * (`readOrganizerTicketingTerms`). The page's hash only proves the person was
 * shown that same text: if the file changed since the page rendered, the
 * click is refused (`terms_changed`) rather than recorded as agreeing to
 * words nobody showed them.
 */
export async function turnOnTicketing(eventId: string, user: User, input: TurnOnInput): Promise<{ ok: true } | { ok: false; reason: TurnOnRefusal }> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!isUuid(eventId)) return { ok: false, reason: "not_found" }
  if (!POLICIES.includes(input.refundPolicy as ticket_refund_policy) || typeof input.feesAbsorbed !== "boolean") return { ok: false, reason: "invalid" }
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null, kind: "event" },
    select: { ...eventPermissionSelect, city: true, ticketing_enabled_at: true },
  })
  if (!event) return { ok: false, reason: "not_found" }
  if (!eventPermissions(await actorFor(user), event).canEdit) return { ok: false, reason: "not_authorized" }
  if (event.ticketing_enabled_at) return { ok: false, reason: "already_enabled" }
  const orgId = event.organizer_org_id
  if (!orgId) return { ok: false, reason: "no_organization" }

  const terms = readOrganizerTicketingTerms()
  if (input.documentSha256 !== terms.sha256) return { ok: false, reason: "terms_changed" }
  // What enableTicketing would refuse anyway, asked before anything is recorded.
  if (!(await payoutStatus(orgId))?.connected) return { ok: false, reason: "payouts_not_connected" }
  if ((await marketFor(event.city))?.ticketing_mode !== "native") return { ok: false, reason: "market_not_native" }

  const accepted = await latestLegalAcceptance(orgId, ORGANIZER_TICKETING_TERMS.key)
  if (accepted?.version !== ORGANIZER_TICKETING_TERMS.version) {
    const recorded = await recordLegalAcceptance({
      orgId,
      userId: user.id,
      documentKey: ORGANIZER_TICKETING_TERMS.key,
      version: ORGANIZER_TICKETING_TERMS.version,
      documentSha256: terms.sha256,
      ip: input.ip,
      userAgent: input.userAgent,
    })
    if (!recorded.ok) return { ok: false, reason: recorded.reason }
  }

  // The buyer-facing choices, while the event is not selling: once on, they are what buyers were shown.
  await db.events.updateMany({
    where: { id: eventId, ticketing_enabled_at: null },
    data: { refund_policy: input.refundPolicy as ticket_refund_policy, fees_absorbed: input.feesAbsorbed },
  })
  const enabled = await enableTicketing(eventId, user)
  return enabled.ok ? { ok: true } : { ok: false, reason: enabled.reason }
}

export type ExternalRefusal = "ticketing_off" | "not_found" | "not_authorized" | "market_not_external" | "invalid"

/**
 * Canada's link out (contract §1): an https link to where the organizer sells,
 * shown in the app as "Tickets on <site>". The site is derived from the link's
 * host, never stored or typed. Nothing fetches the link: a server-side fetch
 * of an organizer's URL is an SSRF surface nobody decided to build. An empty
 * link turns the event back to free.
 */
export async function saveExternalTicketLink(
  eventId: string,
  user: User,
  rawUrl: string
): Promise<{ ok: true; site: string | null } | { ok: false; reason: ExternalRefusal; message?: string }> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!isUuid(eventId)) return { ok: false, reason: "not_found" }
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null, kind: "event" },
    select: { ...eventPermissionSelect, city: true, ticketing_mode: true },
  })
  if (!event) return { ok: false, reason: "not_found" }
  if (!eventPermissions(await actorFor(user), event).canEdit) return { ok: false, reason: "not_authorized" }
  if (event.ticketing_mode === "native" || (await marketFor(event.city))?.ticketing_mode !== "external") return { ok: false, reason: "market_not_external" }

  const raw = typeof rawUrl === "string" ? rawUrl.trim() : ""
  let url: string | null = null
  let site: string | null = null
  if (raw) {
    const parsed = httpsUrl().safeParse(raw)
    site = parsed.success ? externalSiteOf(parsed.data) : null
    if (!parsed.success || !site) return { ok: false, reason: "invalid", message: parsed.success ? "That link has no site in it." : parsed.error.issues[0]?.message }
    url = parsed.data
  }
  await db.events.update({ where: { id: eventId }, data: { ticketing_mode: url ? "external" : "off", external_ticket_url: url } })
  auditLog({ userId: user.id, action: "ticketing.external_link", resource: "event", resourceId: eventId, orgId: event.organizer_org_id, details: { site, cleared: !url } })
  return { ok: true, site }
}
