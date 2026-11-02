import type { Prisma } from "@prisma/client"

import { isUuid } from "./api-input"
import { db } from "./db"
import { ticketingOn } from "./env"
import { violatedConstraint } from "./prisma-errors"
import { parseFeeSchedule, ticketFees, type FeeBreakdown, type FoundingOfferState } from "./ticket-fees"

/**
 * Ticket holds (SCRUM-1008): an order reserves its quantities for
 * `HOLD_MINUTES` while the buyer pays, and an unpaid hold gives them back.
 *
 * ## Why nothing oversells
 *
 * `reserveTickets` locks every ticket type of the event (`FOR UPDATE`, in id
 * order) before it reads a count, so two buyers for the last seat are
 * serialised: the second reads the first's hold. Locking the whole event, not
 * just the order's types, is what makes the slab count (`paidTicketsBefore`)
 * exact too. CHECK `ticket_types_not_oversold` (`sold + held <= quantity`,
 * migration SQL) is the last word if a writer ever skipped the lock, and
 * its refusal is read as sold out.
 *
 * ## Lock order
 *
 * Reserving locks ticket types, then inserts its own new order. The sweeper
 * locks expired orders (`SKIP LOCKED`), then ticket types, in id order. Neither
 * waits on a lock the other takes first, so they cannot deadlock.
 */

export const HOLD_MINUTES = 10
/**
 * Live holds one buyer may have open for one event. Without a cap one account
 * could hold every seat, re-holding each time the ten minutes ran out. Exact:
 * reserving locks the event's types first, so a buyer's two tabs are serialised.
 */
export const MAX_PENDING_PER_BUYER = 2
/** `ticket_orders.total_minor` is INTEGER: an order past it is refused, not a 500 at the insert. */
const MAX_ORDER_TOTAL_MINOR = 2_147_483_647
/** Lines per order: one per ticket type, and no event has more types than this in a sane order. */
const MAX_LINES = 20
const SWEEP_BATCH = 200
const TX = { maxWait: 10_000, timeout: 15_000 }

export type ReserveRefusal =
  | "ticketing_off"
  | "bad_lines"
  | "not_on_sale"
  | "unknown_ticket_type"
  | "over_order_limit"
  | "sold_out"
  | "too_many_holds"

export interface ReserveInput {
  eventId: string
  buyerId: string
  /** One line per ticket type. */
  lines: Array<{ ticketTypeId: string; quantity: number }>
  /** The organisation's plan and founding-offer state, resolved by the caller. */
  pricing: { pro: boolean; founding: FoundingOfferState }
  now?: Date
}

export type ReserveResult =
  | { ok: true; orderId: string; holdExpiresAt: Date; breakdown: FeeBreakdown }
  | { ok: false; reason: ReserveRefusal }

class Refused extends Error {
  constructor(readonly reason: ReserveRefusal) {
    super(reason)
  }
}

interface LockedType {
  id: string
  price_minor: number
  quantity: number
  sold: number
  held: number
  max_per_order: number
  sale_starts_at: Date | null
  sale_ends_at: Date | null
}

function wellFormed(input: ReserveInput): boolean {
  const { lines } = input
  if (!isUuid(input.eventId) || lines.length === 0 || lines.length > MAX_LINES) return false
  if (new Set(lines.map((l) => l.ticketTypeId)).size !== lines.length) return false
  return lines.every((l) => isUuid(l.ticketTypeId) && Number.isSafeInteger(l.quantity) && l.quantity >= 1)
}

async function sellingEvent(tx: Prisma.TransactionClient, eventId: string, now: Date) {
  const event = await tx.events.findUnique({
    where: { id: eventId },
    select: { kind: true, status: true, deleted_at: true, end_time: true, ticketing_mode: true, ticket_fee_schedule: true, fees_absorbed: true },
  })
  const selling =
    event &&
    event.kind === "event" &&
    event.status === "published" &&
    event.deleted_at === null &&
    event.ticketing_mode === "native" &&
    event.end_time > now
  if (!selling) throw new Refused("not_on_sale")
  return event
}

/** Every type of the event, locked in id order (the order the sweeper locks them in too). */
function lockTypes(tx: Prisma.TransactionClient, eventId: string): Promise<LockedType[]> {
  return tx.$queryRaw<LockedType[]>`
    SELECT id::text, price_minor, quantity, sold, held, max_per_order, sale_starts_at, sale_ends_at
      FROM ticket_types
     WHERE event_id = ${eventId}::uuid
     ORDER BY id
       FOR UPDATE`
}

function checkLine(type: LockedType | undefined, quantity: number, now: Date): LockedType {
  if (!type) throw new Refused("unknown_ticket_type")
  if ((type.sale_starts_at && type.sale_starts_at > now) || (type.sale_ends_at && type.sale_ends_at <= now)) throw new Refused("not_on_sale")
  if (quantity > type.max_per_order) throw new Refused("over_order_limit")
  if (type.sold + type.held + quantity > type.quantity) throw new Refused("sold_out")
  return type
}

async function hold(tx: Prisma.TransactionClient, input: ReserveInput, now: Date) {
  const event = await sellingEvent(tx, input.eventId, now)
  const types = await lockTypes(tx, input.eventId)
  const byId = new Map(types.map((t) => [t.id, t]))
  const lines = input.lines.map((l) => ({ ...l, type: checkLine(byId.get(l.ticketTypeId), l.quantity, now) }))
  const live = await tx.ticket_orders.count({
    where: { event_id: input.eventId, buyer_id: input.buyerId, status: "pending", hold_expires_at: { gt: now } },
  })
  if (live >= MAX_PENDING_PER_BUYER) throw new Refused("too_many_holds")

  const breakdown = ticketFees({
    schedule: parseFeeSchedule(event.ticket_fee_schedule),
    paidTicketsBefore: types.filter((t) => t.price_minor > 0).reduce((n, t) => n + t.sold + t.held, 0),
    lines: lines.map((l) => ({ ticketTypeId: l.ticketTypeId, unitPriceMinor: l.type.price_minor, quantity: l.quantity })),
    pro: input.pricing.pro,
    founding: input.pricing.founding,
    feesAbsorbed: event.fees_absorbed,
  })

  if (breakdown.totals.totalMinor > MAX_ORDER_TOTAL_MINOR) throw new Refused("bad_lines")

  for (const l of lines) {
    await tx.ticket_types.update({ where: { id: l.ticketTypeId }, data: { held: { increment: l.quantity } } })
  }
  const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000)
  const { totals } = breakdown
  const order = await tx.ticket_orders.create({
    data: {
      event_id: input.eventId,
      buyer_id: input.buyerId,
      currency: breakdown.currency,
      subtotal_minor: totals.subtotalMinor,
      service_fee_minor: totals.serviceFeeMinor,
      service_fee_tax_minor: totals.serviceFeeTaxMinor,
      processing_fee_minor: totals.processingFeeMinor,
      total_minor: totals.totalMinor,
      fees_absorbed: breakdown.feesAbsorbed,
      fee_breakdown: breakdown as unknown as Prisma.InputJsonObject,
      hold_expires_at: holdExpiresAt,
      lines: {
        create: lines.map((l) => ({ ticket_type_id: l.ticketTypeId, quantity: l.quantity, unit_price_minor: l.type.price_minor })),
      },
    },
    select: { id: true },
  })
  return { ok: true as const, orderId: order.id, holdExpiresAt, breakdown }
}

/**
 * Reserve an order's quantities and write it `pending` with its fee breakdown,
 * all or nothing. A refusal is an answer, not an error; a broken fee snapshot
 * on the event throws (`TicketFeeError`), because that is ours to fix.
 *
 * The caller has authenticated `buyerId` and decided they may buy (an
 * attendee, not suspended, of age for the event): this checks the order, not
 * the person.
 */
export async function reserveTickets(input: ReserveInput): Promise<ReserveResult> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!wellFormed(input)) return { ok: false, reason: "bad_lines" }
  const now = input.now ?? new Date()
  try {
    return await db.$transaction((tx) => hold(tx, input, now), TX)
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason }
    if (violatedConstraint(error, "ticket_types_not_oversold")) return { ok: false, reason: "sold_out" }
    throw error
  }
}

/**
 * Expire pending orders whose hold has run out and give their quantities back.
 * For the sweeper: safe to run concurrently and repeatedly (`SKIP LOCKED`, and
 * only `pending` orders move), one batch per call. Runs whether or not
 * `TICKETING` is on, so turning it off never strands a hold.
 */
export async function releaseExpiredHolds(opts: { now?: Date; limit?: number } = {}): Promise<{ released: number }> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? SWEEP_BATCH
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit is a positive integer")
  return db.$transaction(async (tx) => {
    const orders = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM ticket_orders
       WHERE status = 'pending' AND hold_expires_at <= ${now}
       ORDER BY hold_expires_at
       LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`
    if (orders.length === 0) return { released: 0 }
    const ids = orders.map((o) => o.id)
    const back = await tx.ticket_order_lines.groupBy({ by: ["ticket_type_id"], where: { order_id: { in: ids } }, _sum: { quantity: true } })
    const typeIds = back.map((b) => b.ticket_type_id)
    await tx.$queryRaw`SELECT id FROM ticket_types WHERE id = ANY(${typeIds}::uuid[]) ORDER BY id FOR UPDATE`
    for (const b of back) {
      await tx.ticket_types.update({ where: { id: b.ticket_type_id }, data: { held: { decrement: b._sum.quantity ?? 0 } } })
    }
    await tx.ticket_orders.updateMany({ where: { id: { in: ids }, status: "pending" }, data: { status: "expired" } })
    return { released: ids.length }
  }, TX)
}
