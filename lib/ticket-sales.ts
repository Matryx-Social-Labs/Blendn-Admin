import { Prisma } from "@prisma/client"

import { isUuid } from "./api-input"
import { db } from "./db"
import { attendeeLabel } from "./pseudonym"
import { eventPermissionSelect, eventPermissions, type PermissionActor } from "./rbac"
import { labelScopeFor } from "./reports"
import { holdFloor, organizerShare, payoutReleased } from "./ticket-payments"

/**
 * What the Tickets tab reads about money and orders (SCRUM-1014): the Sales
 * panel, paged on the server, and the totals behind the money's path.
 *
 * A buyer is their attendee label (`attendeeLabel`, salted as the Attendees
 * tab and the exports salt it, `labelScopeFor`), never a person: nothing here
 * selects a name, email or the buyer's id onto a row (R1, hosts see
 * pseudonyms only). The one name read is the organization member who refunded
 * an order, from the audit row the refund wrote.
 */

export const SALES_PAGE_SIZE = 50
/** The newest refunds the panel lists; the Sales table has every one. */
const REFUNDS_SHOWN = 20
/** Orders a buyer search scans for labels. Past this, search by order reference. */
const LABEL_SEARCH_SCAN = 20_000

export type SaleStatus = "paid" | "refunding" | "refunded"
export type SalesStatusFilter = "all" | "paid" | "refunded"

export interface SaleRow {
  id: string
  /** The order id's first 8 characters: nothing writes a "BL-" reference. */
  ref: string
  label: string
  types: string
  quantity: number
  /** What the tickets cost, without the booking fee. */
  ticketPriceMinor: number
  /** What the buyer paid, the booking fee included unless it was absorbed. */
  totalMinor: number
  /** What a refund from here returns: the organizer's share (the booking fee is kept). */
  refundMinor: number
  bookingFeeMinor: number
  status: SaleStatus
  refundedAt: Date | null
  createdAt: Date
  /** Paid, not already being refunded, and the payout not yet released. */
  refundable: boolean
}

export interface SalesQuery {
  page: number
  q?: string
  typeId?: string
  status?: SalesStatusFilter
}

export interface SalesPage {
  rows: SaleRow[]
  total: number
  page: number
  pages: number
  currency: string
}


const statusOf = (o: { status: string; refund_requested_at: Date | null }): SaleStatus =>
  o.status === "refunded" ? "refunded" : o.refund_requested_at ? "refunding" : "paid"

/** Order ids whose reference starts with `prefix`, for the search box. */
async function idsByRef(eventId: string, prefix: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM ticket_orders
     WHERE event_id = ${eventId}::uuid AND status IN ('paid', 'refunded') AND id::text LIKE ${`${prefix.toLowerCase()}%`}
     LIMIT 200`
  return rows.map((r) => r.id)
}

/** Buyers whose label starts with `q`: labels are HMACs, so they are computed, not queried. */
async function buyersByLabel(eventId: string, q: string, scope: string): Promise<string[]> {
  const rows = await db.ticket_orders.findMany({
    where: { event_id: eventId, status: { in: ["paid", "refunded"] } },
    distinct: ["buyer_id"],
    select: { buyer_id: true },
    take: LABEL_SEARCH_SCAN,
  })
  const needle = q.toLowerCase()
  return rows.map((r) => r.buyer_id).filter((b) => attendeeLabel(b, scope).startsWith(needle))
}

/** One page of an event's sales, for whoever may edit the event; null for anyone else. */
export async function salesPage(actor: PermissionActor, eventId: string, query: SalesQuery, now: Date = new Date()): Promise<SalesPage | null> {
  if (!isUuid(eventId)) return null
  const event = await db.events.findFirst({ where: { id: eventId, deleted_at: null }, select: { ...eventPermissionSelect, start_time: true, end_time: true, ticket_fee_schedule: true } })
  if (!event || !eventPermissions(actor, event).canEdit) return null
  const scope = labelScopeFor(actor, event.organizer_org_id)

  const where: Prisma.ticket_ordersWhereInput = {
    event_id: eventId,
    status: query.status === "paid" ? "paid" : query.status === "refunded" ? "refunded" : { in: ["paid", "refunded"] },
  }
  if (query.typeId && isUuid(query.typeId)) where.lines = { some: { ticket_type_id: query.typeId } }
  const q = query.q?.trim() ?? ""
  if (/^attendee-[0-9a-f]{1,12}$/i.test(q)) where.buyer_id = { in: await buyersByLabel(eventId, q, scope) }
  else if (/^[0-9a-f]{1,8}$/i.test(q)) where.id = { in: await idsByRef(eventId, q) }
  else if (q) where.id = { in: [] }

  const total = await db.ticket_orders.count({ where })
  const pages = Math.max(1, Math.ceil(total / SALES_PAGE_SIZE))
  const page = Math.min(Math.max(1, Math.trunc(query.page) || 1), pages)
  const orders = await db.ticket_orders.findMany({
    where,
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    skip: (page - 1) * SALES_PAGE_SIZE,
    take: SALES_PAGE_SIZE,
    select: {
      id: true,
      buyer_id: true,
      status: true,
      created_at: true,
      subtotal_minor: true,
      total_minor: true,
      service_fee_minor: true,
      service_fee_tax_minor: true,
      processing_fee_minor: true,
      fees_absorbed: true,
      refund_requested_at: true,
      refunded_at: true,
      payout: { select: { on_hold_until: true } },
      lines: { select: { quantity: true, ticket_type: { select: { name: true, sort: true } } } },
    },
  })
  const rows = orders.map((o): SaleRow => {
    const status = statusOf(o)
    const lines = [...o.lines].sort((a, b) => a.ticket_type.sort - b.ticket_type.sort)
    return {
      id: o.id,
      ref: o.id.slice(0, 8).toUpperCase(),
      label: attendeeLabel(o.buyer_id, scope),
      types: lines.map((l) => l.ticket_type.name).join(", "),
      quantity: lines.reduce((n, l) => n + l.quantity, 0),
      ticketPriceMinor: o.subtotal_minor,
      totalMinor: o.total_minor,
      refundMinor: organizerShare(o),
      bookingFeeMinor: o.fees_absorbed ? 0 : o.total_minor - o.subtotal_minor,
      status,
      refundedAt: o.refunded_at,
      createdAt: o.created_at,
      // The same rule refundOrder enforces, on the same recorded hold: the flag only hides what the lib would refuse.
      refundable: status === "paid" && !payoutReleased({ onHoldUntil: o.payout?.on_hold_until ?? null, event }, now),
    }
  })
  const currency = (event.ticket_fee_schedule as { currency?: string } | null)?.currency ?? "INR"
  return { rows, total, page, pages, currency }
}

export interface RefundRow {
  ref: string
  amountMinor: number
  /** Null while Razorpay has not confirmed it. */
  refundedAt: Date | null
  /** The member who refunded it, or why it went back (a cancelled event, a late payment). */
  by: string
}

export interface TicketsSummary {
  soldTickets: number
  refundedTickets: number
  capacity: number
  /** The organizer's share of every order that was paid, refunded or not. */
  grossMinor: number
  refundedMinor: number
  /** What the organizer is owed now: gross less refunds. */
  payoutMinor: number
  releaseAt: Date
  released: boolean
  refundedOrders: number
  refunds: RefundRow[]
  inside: number
}

const REASON_BY: Record<string, string> = {
  event_cancelled: "Event canceled",
  late_payment: "Paid after the hold ran out",
  buyer_deleted: "Account deleted",
}

/**
 * The money behind the hero and the payout panel. The caller has already
 * asked `eventPermissions(...).canEdit`: the page does, before anything here.
 */
export async function ticketsSummary(eventId: string, now: Date = new Date()): Promise<TicketsSummary> {
  const [event, types, orders, inside] = await Promise.all([
    db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true, end_time: true } }),
    db.ticket_types.aggregate({ where: { event_id: eventId }, _sum: { quantity: true } }),
    // Per order through its status index, its lines by their primary key: no scan of the event's lines.
    db.$queryRaw<{ status: string; orders: bigint; tickets: bigint; share: bigint }[]>`
      SELECT o.status::text AS status, count(*) AS orders, coalesce(sum(q.qty), 0) AS tickets,
             coalesce(sum(o.total_minor - o.service_fee_minor - o.service_fee_tax_minor - o.processing_fee_minor), 0) AS share
        FROM ticket_orders o
        CROSS JOIN LATERAL (SELECT sum(l.quantity) AS qty FROM ticket_order_lines l WHERE l.order_id = o.id) q
       WHERE o.event_id = ${eventId}::uuid AND o.status IN ('paid', 'refunded')
       GROUP BY o.status`,
    db.tickets.count({ where: { event_id: eventId, redeemed_at: { not: null }, order: { status: "paid" } } }),
  ])
  const of = (s: string) => orders.find((o) => o.status === s)
  const paid = of("paid")
  const refunded = of("refunded")
  const refundedMinor = Number(refunded?.share ?? 0)
  const grossMinor = Number(paid?.share ?? 0) + refundedMinor
  // The latest hold any payout recorded, else the event's end + 3 days: what the organizer waits for.
  const latestHold = await db.ticket_payouts.aggregate({ where: { order: { event_id: eventId } }, _max: { on_hold_until: true } })
  const releaseAt = latestHold._max.on_hold_until ?? holdFloor(event)
  return {
    soldTickets: Number(paid?.tickets ?? 0),
    refundedTickets: Number(refunded?.tickets ?? 0),
    capacity: types._sum.quantity ?? 0,
    grossMinor,
    refundedMinor,
    payoutMinor: grossMinor - refundedMinor,
    releaseAt,
    released: payoutReleased({ onHoldUntil: releaseAt, event }, now),
    refundedOrders: Number(refunded?.orders ?? 0),
    refunds: await refundsOf(eventId),
    inside,
  }
}

async function refundsOf(eventId: string): Promise<RefundRow[]> {
  const orders = await db.ticket_orders.findMany({
    where: { event_id: eventId, refund_requested_at: { not: null } },
    orderBy: [{ refund_requested_at: "desc" }, { id: "desc" }],
    take: REFUNDS_SHOWN,
    select: { id: true, refund_requested_minor: true, refunded_minor: true, refunded_at: true, refund_reason: true, status: true },
  })
  if (orders.length === 0) return []
  // Who: the member the organizer's refund audit row names. A colleague, never a buyer.
  const audits = await db.audit_logs.findMany({
    where: { action: "ticket_order.refund", resource_id: { in: orders.map((o) => o.id) } },
    select: { resource_id: true, user_id: true },
  })
  const members = await db.user.findMany({ where: { id: { in: audits.flatMap((a) => (a.user_id ? [a.user_id] : [])) } }, select: { id: true, name: true } })
  const nameOf = new Map(members.map((m) => [m.id, m.name ?? "A member"]))
  const byOrder = new Map(audits.map((a) => [a.resource_id, (a.user_id && nameOf.get(a.user_id)) || "A member"]))
  return orders.map((o) => ({
    ref: o.id.slice(0, 8).toUpperCase(),
    amountMinor: o.status === "refunded" ? o.refunded_minor : (o.refund_requested_minor ?? 0),
    refundedAt: o.refunded_at,
    by: byOrder.get(o.id) ?? REASON_BY[o.refund_reason ?? ""] ?? "Blend’n",
  }))
}
