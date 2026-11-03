import type { Prisma } from "@prisma/client"
import { NextResponse } from "next/server"
import { z } from "zod"

import { isUuid } from "./api-input"
import { errorResponse, ErrorCode } from "./api-response"
import { db } from "./db"
import { activeMembership } from "./org-membership"
import { ticketingOn } from "./env"
import { parseFeeSchedule, type FeeBreakdown } from "./ticket-fees"
import type { ReserveRefusal } from "./ticket-holds"
import { ticketQrPayload } from "./tickets"

/**
 * What the mobile ticket routes read and answer (SCRUM-1011, contract §1–3,
 * §5–6 and §8 v1.1). Shapes only: who may buy, at what price, is
 * lib/ticket-holds.ts; who may read an order is the route (its buyer).
 */

/** Below this many left a type says how many (contract §1: no "1,940 left"). */
const REMAINING_SHOWN_AT = 20
// ponytail: unpaginated per contract §8.10 (a buyer has ≤10 seats an event); page it when someone holds hundreds.
const MY_TICKETS_MAX = 500

/* ------------------------------------------------------------------------ */
/* Input and refusals                                                        */
/* ------------------------------------------------------------------------ */

export const linesSchema = z.object({
  lines: z
    .array(z.object({ typeId: z.string().refine(isUuid, "typeId is a uuid"), quantity: z.number().int().min(1).max(100) }))
    .min(1)
    .max(20),
})

export const toReserveLines = (lines: z.infer<typeof linesSchema>["lines"]) => lines.map((l) => ({ ticketTypeId: l.typeId, quantity: l.quantity }))

/** Each refusal's answer: 409 with the contract's code in `errorCode` (§2, §3, §8.1). */
const REFUSALS: Record<ReserveRefusal, [number, string, string]> = {
  ticketing_off: [404, ErrorCode.NOT_FOUND, "Not found"],
  bad_lines: [400, ErrorCode.VALIDATION_FAILED, "Those tickets can’t be ordered"],
  buyer_not_allowed: [403, ErrorCode.FORBIDDEN, "This account can’t buy tickets"],
  // The routes answer the RSVP's own response before reserving (`eventAccessResponse`); this is the backstop.
  no_access: [404, ErrorCode.NOT_FOUND, "Event not found"],
  not_on_sale: [409, "not_on_sale", "Those tickets aren’t on sale"],
  private: [409, "private", "This event is invite-only"],
  under_age: [409, "age", "This event has a minimum age"],
  unknown_ticket_type: [409, "unknown_ticket_type", "That ticket isn’t available"],
  over_order_limit: [409, "over_order_limit", "That’s more than one order can hold"],
  sold_out: [409, "sold_out", "Sold out"],
  too_many_holds: [409, "too_many_holds", "You already have tickets held for this event"],
  too_many_seats: [409, "over_buyer_limit", "That’s more tickets than one person can buy for this event"],
  // An event priced to nothing, or fees above a price: the organizer's to fix, not the buyer's.
  free_order: [409, "not_on_sale", "Those tickets aren’t on sale"],
  fees_exceed_price: [409, "not_on_sale", "Those tickets aren’t on sale"],
  busy: [409, "busy", "Busy, try again"],
}

export function refusalResponse(reason: ReserveRefusal): NextResponse {
  const [status, code, message] = REFUSALS[reason]
  // `busy`: retry after a second, at most twice (contract §3).
  if (reason === "busy") return NextResponse.json({ success: false, error: message, errorCode: code, retryAfter: 1 }, { status })
  return errorResponse(message, status, code)
}

/* ------------------------------------------------------------------------ */
/* Quote                                                                     */
/* ------------------------------------------------------------------------ */

export async function quoteView(b: FeeBreakdown, marketCode: string) {
  const market = await db.markets.findUnique({ where: { code: marketCode }, select: { ticket_tax_label: true } })
  const t = b.totals
  return {
    currency: b.currency,
    subtotalMinor: t.subtotalMinor,
    // Zero when absorbed (ticket-fees): the buyer pays the price and sees no fee parts (§8.9); the organizer sees them on the dashboard.
    bookingFeeMinor: t.bookingFeeMinor,
    totalMinor: t.totalMinor,
    taxLabel: market?.ticket_tax_label ?? "Tax",
    ...(b.feesAbsorbed ? {} : { feeParts: { serviceMinor: t.serviceFeeMinor, taxMinor: t.serviceFeeTaxMinor, processingMinor: t.processingFeeMinor } }),
    lines: b.lines.map((l) => ({ typeId: l.ticketTypeId, quantity: l.quantity, unitMinor: l.unitPriceMinor })),
  }
}

/* ------------------------------------------------------------------------ */
/* GET /events/:id `ticketing`                                               */
/* ------------------------------------------------------------------------ */

type TypeStatus = "on_sale" | "sold_out" | "not_started" | "ended"

/** The external link's own host, `www.` dropped: derived, never stored, so the label is where the link goes. */
export function externalSiteOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "") || null
  } catch {
    return null
  }
}

export async function eventTicketing(eventId: string, viewerId: string, now: Date = new Date()) {
  if (!ticketingOn()) return null
  const event = await db.events.findUnique({
    where: { id: eventId },
    select: { ticketing_mode: true, external_ticket_url: true, fees_absorbed: true, refund_policy: true, ticket_fee_schedule: true, end_time: true },
  })
  if (!event || event.ticketing_mode === "off") return null
  if (event.ticketing_mode === "external") {
    const url = event.external_ticket_url
    const site = url ? externalSiteOf(url) : null
    return url && site ? { mode: "external" as const, externalUrl: url, externalSite: site } : null
  }

  const [types, mine] = await Promise.all([
    // Never a hidden type (it is not on sale to anyone) nor a free one (free is RSVP plus capacity, §8.11).
    db.ticket_types.findMany({
      where: { event_id: eventId, hidden: false, price_minor: { gt: 0 } },
      orderBy: [{ sort: "asc" }, { id: "asc" }],
      select: { id: true, name: true, price_minor: true, quantity: true, sold: true, held: true, sale_starts_at: true, sale_ends_at: true, max_per_order: true },
    }),
    db.ticket_orders.findMany({
      where: { event_id: eventId, buyer_id: viewerId, status: "paid" },
      orderBy: { created_at: "asc" },
      select: { id: true, _count: { select: { tickets: true } } },
    }),
  ])
  const shaped = types.map((t) => {
    const left = Math.max(0, t.quantity - t.sold - t.held)
    const status: TypeStatus =
      (t.sale_ends_at && t.sale_ends_at <= now) || event.end_time <= now
        ? "ended"
        : t.sale_starts_at && t.sale_starts_at > now
          ? "not_started"
          : left === 0
            ? "sold_out"
            : "on_sale"
    return {
      id: t.id,
      name: t.name,
      description: null,
      priceMinor: t.price_minor,
      status,
      remaining: status === "on_sale" && left <= REMAINING_SHOWN_AT ? left : null,
      salesStartAt: t.sale_starts_at?.toISOString() ?? null,
      salesEndAt: t.sale_ends_at?.toISOString() ?? null,
      maxPerOrder: t.max_per_order,
    }
  })
  const onSale = shaped.filter((t) => t.status === "on_sale").map((t) => t.priceMinor)
  return {
    mode: "native" as const,
    currency: parseFeeSchedule(event.ticket_fee_schedule).currency,
    fromMinor: onSale.length ? Math.min(...onSale) : null,
    feesAbsorbed: event.fees_absorbed,
    refundPolicy: event.refund_policy,
    types: shaped,
    mine: mine.length ? { ticketCount: mine.reduce((n, o) => n + o._count.tickets, 0), orderIds: mine.map((o) => o.id) } : null,
  }
}

/** A plain RSVP is refused on a native ticketed event (§8.6): the ticket is the RSVP. Off, the RSVP is the door. */
export async function ticketsRequired(eventId: string): Promise<boolean> {
  if (!ticketingOn()) return false
  const event = await db.events.findUnique({ where: { id: eventId }, select: { ticketing_mode: true } })
  return event?.ticketing_mode === "native"
}

/**
 * Whether the mobile check-in must refuse this person (SCRUM-1014, the hole
 * #907 left open): on a native ticketed event, someone who is not the event's
 * staff (its organization, the venue's owner) and holds no valid ticket, one
 * whose order is paid. Redeemed at the door or not: the door and check-in
 * are separate acts, and the ticket is what both ask for.
 */
export async function missingTicketAtCheckIn(
  event: { id: string; ticketing_mode: string; organizer_org_id: string | null; venue?: { owner_org_id: string | null } | null },
  userId: string
): Promise<boolean> {
  if (!ticketingOn() || event.ticketing_mode !== "native") return false
  const staffOrgs = [event.organizer_org_id, event.venue?.owner_org_id ?? null].filter((o): o is string => o !== null)
  const [staff, ticket] = await Promise.all([
    staffOrgs.length ? db.organisation_members.findFirst({ where: { user_id: userId, org_id: { in: staffOrgs }, ...activeMembership }, select: { id: true } }) : null,
    db.tickets.findFirst({ where: { event_id: event.id, holder_id: userId, order: { status: "paid" } }, select: { id: true } }),
  ])
  return !staff && !ticket
}

/**
 * Whether an event's start and end are fixed (SCRUM-1014): it has started and
 * has paid ticket orders: its buyers paid for that night. Before it starts an
 * edit is allowed, and moving it later simply moves its payouts' release with
 * it (`holdFloor`, read by the release job when it runs).
 */
export async function ticketTimesLocked(event: { id: string; start_time: Date }, now: Date = new Date()): Promise<boolean> {
  if (event.start_time > now) return false
  return (await db.ticket_orders.count({ where: { event_id: event.id, status: "paid" }, take: 1 })) > 0
}

export const TIMES_LOCKED_SENTENCE = "This event has started and has sold tickets, so its start and end can’t change."

export const NO_TICKET_SENTENCE = "This event needs a ticket. Get one on the event page, then check in."

/* ------------------------------------------------------------------------ */
/* Orders and tickets                                                        */
/* ------------------------------------------------------------------------ */

const ticketSelect = {
  id: true,
  order_id: true,
  event_id: true,
  door_code: true,
  redeemed_at: true,
  // A ticket reaches its event through its type (the composite keys keep them the same event).
  ticket_type: { select: { name: true, event: { select: { id: true, title: true, start_time: true, end_time: true, timezone: true, venue_name: true, cover_image_url: true } } } },
} satisfies Prisma.ticketsSelect

type TicketRow = {
  id: string
  order_id: string
  event_id: string
  door_code: string
  redeemed_at: Date | null
  ticket_type: Prisma.ticket_typesGetPayload<{ select: (typeof ticketSelect)["ticket_type"]["select"] }>
}

/** One ticket as the pass draws it, with its event, so it renders offline (§6, §8.4). The QR is derived, never stored. */
const ticketView = ({ ticket_type: { event, ...type }, ...t }: TicketRow) => ({
  ticketId: t.id,
  orderId: t.order_id,
  eventId: t.event_id,
  typeName: type.name,
  doorCode: t.door_code,
  qrPayload: ticketQrPayload(t.id),
  redeemedAt: t.redeemed_at?.toISOString() ?? null,
  event: {
    id: event.id,
    title: event.title,
    startsAt: event.start_time.toISOString(),
    endsAt: event.end_time.toISOString(),
    timezone: event.timezone,
    venueName: event.venue_name,
    coverUrl: event.cover_image_url,
  },
})

/** The buyer's order, or null for anyone else: a stranger cannot tell it exists (§5). */
export async function orderView(orderId: string, buyerId: string) {
  if (!isUuid(orderId)) return null
  const order = await db.ticket_orders.findFirst({
    where: { id: orderId, buyer_id: buyerId },
    select: {
      id: true,
      event_id: true,
      status: true,
      hold_expires_at: true,
      total_minor: true,
      currency: true,
      payment_failed_at: true,
      tickets: { select: ticketSelect, orderBy: [{ created_at: "asc" }, { id: "asc" }] },
    },
  })
  if (!order) return null
  return {
    orderId: order.id,
    eventId: order.event_id,
    status: order.status,
    holdExpiresAt: order.hold_expires_at.toISOString(),
    totalMinor: order.total_minor,
    currency: order.currency,
    paymentFailed: order.status === "pending" && order.payment_failed_at !== null,
    // A refunded order's tickets stay as rows and the door refuses them; the buyer is shown none.
    tickets: order.status === "paid" ? order.tickets.map(ticketView) : [],
  }
}

/** My tickets: of paid orders only, newest event first. */
export async function myTicketsView(holderId: string, eventId: string | null) {
  const tickets = await db.tickets.findMany({
    where: { holder_id: holderId, order: { status: "paid" }, ...(eventId ? { event_id: eventId } : {}) },
    select: ticketSelect,
    orderBy: [{ ticket_type: { event: { start_time: "desc" } } }, { created_at: "asc" }, { id: "asc" }],
    take: MY_TICKETS_MAX,
  })
  return tickets.map(ticketView)
}
