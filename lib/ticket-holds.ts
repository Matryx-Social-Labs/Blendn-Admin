import { Prisma } from "@prisma/client"

// Relative imports: lib/ticket-hold-sweeper.ts reaches this from server.ts, and `build:server`
// compiles with plain tsc, which emits the @/ alias verbatim into the require().
import { ageFrom, minAgeRefusal } from "./age"
import { isUuid } from "./api-input"
import { db } from "./db"
import { ticketingOn } from "./env"
import { attendeeEventAccess } from "./event-door"
import { violatedConstraint } from "./prisma-errors"
import { FeesExceedPriceError, parseFeeSchedule, ticketFees, type FeeBreakdown } from "./ticket-fees"

/**
 * Ticket holds (SCRUM-1008, hardened in SCRUM-1010): an order reserves its
 * quantities for `HOLD_MINUTES` while the buyer pays, and an unpaid hold gives
 * them back.
 *
 * ## Why nothing oversells
 *
 * `reserveTickets` locks every ticket type of the event (`FOR UPDATE`, in id
 * order) before it reads a count, so two buyers for the last seat are
 * serialised: the second reads the first's hold. Locking the whole event, not
 * just the order's types, is what makes the per-buyer seat count and the slab
 * count exact too. CHECK `ticket_types_not_oversold` (`sold + held <=
 * quantity`, migration SQL) is the last word if a writer ever skipped the
 * lock, and its refusal is read as sold out.
 *
 * ## Why one buyer cannot hold the room (security H1, database M3)
 *
 * A buyer has at most `MAX_SEATS_PER_BUYER` seats for an event, counting
 * unexpired holds and paid orders together, and one order holds at most that
 * many. Before counting, the event's expired holds are given back inline,
 * under the type locks this already holds (database HIGH 2): a seat whose hold
 * ran out is on sale now, not when the sweeper next passes.
 *
 * ## Lock order
 *
 * | Who                          | Takes, in this order                                                    |
 * |------------------------------|-------------------------------------------------------------------------|
 * | `reserveTickets`             | the event's types (id order), then expired orders `SKIP LOCKED`, then inserts its own |
 * | `releaseExpiredHolds`        | expired orders `SKIP LOCKED`, then their types (id order)               |
 * | the payment webhook (lib/ticket-payments.ts) | its order, then the order's types (id order)           |
 * | a refund (`finishRefund`)    | its order, then the order's types (id order)                           |
 * | `cancelBuyerHolds` / `cancelHold` / `cancelEventHolds` | pending orders (id order, waiting), then their types (id order) |
 *
 * Reserving never waits on an order lock (`SKIP LOCKED`), and everyone takes
 * types in id order, so there is no cycle. Each transaction sets
 * `lock_timeout` (2 s) first: a longer wait is answered `busy`, not a
 * pooled connection held for the transaction timeout.
 *
 * ## Late payment: the Phase 2 contract (security M4, database 7)
 *
 * Built in lib/ticket-payments.ts (SCRUM-1011), exactly this.
 *
 * 1. The webhook locks the order (`FOR UPDATE`), then the order's types in id
 *    order — the order above, so it cannot deadlock a reserve or the sweeper.
 * 2. It charges and checks nothing but the order row: the amount captured
 *    must equal `ticket_orders.total_minor`, in `ticket_orders.currency`.
 * 3. A `pending` order still in its hold: `held -= q`, `sold += q` per line,
 *    status `paid`, and its tickets issued in the same transaction
 *    (`tickets_order_must_be_paid` refuses a ticket for any order not paid).
 * 4. An `expired` order (the buyer paid after the hold ran out and the seats
 *    went back): if every line still fits (`sold + held + q <= quantity`), it
 *    re-reserves straight to `sold` and proceeds as 3. Otherwise it is refunded
 *    in full, automatically, marked `refunded`, and the buyer is told — never
 *    issued tickets that oversell the room.
 * 5. Replays are no-ops: `provider_payment_ref` is unique per provider.
 *
 * Account deletion cancels the person's pending holds (`cancelBuyerHolds`:
 * status `cancelled`, seats back as the sweeper gives them), right after the
 * erasure commits, so no hold outlives the account by its ten minutes; a
 * payment that lands on one is refunded (lib/ticket-payments.ts). Their paid
 * orders stay, because an order is a money record (FK RESTRICT).
 */

export const HOLD_MINUTES = 10
/** Live holds one buyer may have open for one event: each is rows to sweep, so a buyer gets two tabs, not twenty. */
export const MAX_PENDING_PER_BUYER = 2
/**
 * Seats one buyer may have for one event, unexpired holds and paid orders
 * counted together; also the most one order may hold. Exact: reserving locks
 * the event's types first, so a buyer's two tabs are serialised.
 */
export const MAX_SEATS_PER_BUYER = 10
/** `ticket_orders.total_minor` is INTEGER: an order past it is refused, not a 500 at the insert. */
const MAX_ORDER_TOTAL_MINOR = 2_147_483_647
/** Lines per order: one per ticket type, and no event has more types than this in a sane order. */
const MAX_LINES = 20
const SWEEP_BATCH = 200
const TX = { maxWait: 10_000, timeout: 15_000 }

export type ReserveRefusal =
  | "ticketing_off"
  | "bad_lines"
  | "buyer_not_allowed"
  /** The RSVP's door refuses them (`attendeeEventAccess`, participate): not found to them, or not set up. */
  | "no_access"
  | "not_on_sale"
  | "private"
  | "under_age"
  | "unknown_ticket_type"
  | "over_order_limit"
  | "sold_out"
  | "too_many_holds"
  | "too_many_seats"
  | "free_order"
  | "fees_exceed_price"
  | "busy"

/**
 * What a buyer asks for. Nothing about price: the rule and the rates are the
 * event's (`enableTicketing`), the prices are the types', and the clock is the
 * server's. A request that could say "price me as Pro" was one (security H4).
 */
export interface ReserveInput {
  eventId: string
  buyerId: string
  /** One line per ticket type, in any order: they are priced dearest first (lib/ticket-fees.ts). */
  lines: Array<{ ticketTypeId: string; quantity: number }>
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
  hidden: boolean
  sale_starts_at: Date | null
  sale_ends_at: Date | null
}

function wellFormed(input: ReserveInput): boolean {
  const { lines } = input
  if (!isUuid(input.eventId) || typeof input.buyerId !== "string" || input.buyerId === "") return false
  if (lines.length === 0 || lines.length > MAX_LINES) return false
  if (new Set(lines.map((l) => l.ticketTypeId)).size !== lines.length) return false
  return lines.every((l) => isUuid(l.ticketTypeId) && Number.isSafeInteger(l.quantity) && l.quantity >= 1)
}

/** The buyer's standing and age, before the transaction: nothing here needs a lock. Null is refused. */
async function buyerAge(buyerId: string): Promise<{ age: number | null } | null> {
  const buyer = await db.user.findUnique({
    where: { id: buyerId },
    select: { suspended_at: true, deletedAt: true, profile: { select: { age: true, date_of_birth: true } } },
  })
  if (!buyer || buyer.suspended_at || buyer.deletedAt) return null
  // Derived from the birth date, never the stored column (lib/age.ts).
  return { age: ageFrom(buyer.profile) }
}

/**
 * The RSVP's door (security review, gate parity): whoever `POST /rsvp` would
 * refuse — not found to them (a draft, a stranger's private event, a closed
 * city), too young or of unknown age for it, not set up — buys nothing. The
 * routes answer with the RSVP's own response first; this is the backstop for
 * every other caller, the late payment included.
 */
async function doorRefusal(input: Pick<ReserveInput, "eventId" | "buyerId">): Promise<ReserveRefusal | null> {
  const denied = await attendeeEventAccess(input.buyerId, input.eventId, "participate")
  if (!denied) return null
  return denied.kind === "age" ? "under_age" : "no_access"
}

/** First in every transaction here: a row lock waited on past 2 s is `busy`. A literal, because SET takes no parameter. */
const setLockTimeout = (tx: Prisma.TransactionClient) => tx.$executeRaw`SET LOCAL lock_timeout = '2s'`

/** Every type of the event, locked in id order (the order everyone locks them in). */
function lockTypes(tx: Prisma.TransactionClient, eventId: string): Promise<LockedType[]> {
  return tx.$queryRaw<LockedType[]>`
    SELECT id::text, price_minor, quantity, sold, held, max_per_order, hidden, sale_starts_at, sale_ends_at
      FROM ticket_types
     WHERE event_id = ${eventId}::uuid
     ORDER BY id
       FOR UPDATE`
}

/**
 * Every type of the event, unlocked, for a quote: `held` less what lapsed
 * holds still count, so the quote says what an order placed now would find
 * (an order gives lapsed holds back before it counts).
 */
function readTypes(eventId: string, now: Date): Promise<LockedType[]> {
  return db.$queryRaw<LockedType[]>`
    SELECT t.id::text, t.price_minor, t.quantity, t.sold,
           t.held - coalesce((SELECT sum(l.quantity) FROM ticket_order_lines l JOIN ticket_orders o ON o.id = l.order_id
                               WHERE l.ticket_type_id = t.id AND o.status = 'pending' AND o.hold_expires_at <= ${now}), 0)::int AS held,
           t.max_per_order, t.hidden, t.sale_starts_at, t.sale_ends_at
      FROM ticket_types t
     WHERE t.event_id = ${eventId}::uuid`
}

/** Read after the type locks, so nothing it says can change under the order (database HIGH 1). */
async function sellingEvent(tx: Prisma.TransactionClient, eventId: string, age: number | null, now: Date) {
  const event = await tx.events.findUnique({
    where: { id: eventId },
    select: {
      kind: true,
      status: true,
      visibility: true,
      deleted_at: true,
      end_time: true,
      min_age: true,
      ticketing_mode: true,
      ticket_fee_schedule: true,
      ticket_fee_rule: true,
      fees_absorbed: true,
    },
  })
  const selling =
    event &&
    event.kind === "event" &&
    event.status === "published" &&
    event.deleted_at === null &&
    event.ticketing_mode === "native" &&
    event.ticket_fee_rule !== null &&
    event.end_time > now
  if (!selling) throw new Refused("not_on_sale")
  // A private event's guest list is its own door (security M5); nobody buys their way past it.
  if (event.visibility === "private") throw new Refused("private")
  // Unknown age is a no, as at the door (minAgeRefusal).
  if (minAgeRefusal(age, event.min_age)) throw new Refused("under_age")
  return { ...event, ticket_fee_rule: event.ticket_fee_rule! }
}

/**
 * Expire these pending orders and give their seats back, in one statement per
 * table. The caller holds the orders' row locks; their types are locked here
 * in id order, which is a no-op for a reserve that already holds them.
 */
async function expireOrders(tx: Prisma.TransactionClient, ids: string[], to: "expired" | "cancelled" = "expired"): Promise<void> {
  const back = await tx.ticket_order_lines.groupBy({ by: ["ticket_type_id"], where: { order_id: { in: ids } }, _sum: { quantity: true } })
  const typeIds = back.map((b) => b.ticket_type_id)
  const quantities = back.map((b) => b._sum.quantity ?? 0)
  await tx.$queryRaw`SELECT id FROM ticket_types WHERE id = ANY(${typeIds}::uuid[]) ORDER BY id FOR UPDATE`
  await tx.$executeRaw`
    UPDATE ticket_types AS t SET held = t.held - v.quantity, updated_at = now()
      FROM unnest(${typeIds}::uuid[], ${quantities}::int[]) AS v(id, quantity)
     WHERE t.id = v.id`
  await tx.ticket_orders.updateMany({ where: { id: { in: ids }, status: "pending" }, data: { status: to } })
}

/** The event's holds that have run out, given back now. `SKIP LOCKED`: one the sweeper holds is its to finish. */
async function reclaimExpired(tx: Prisma.TransactionClient, eventId: string, now: Date): Promise<boolean> {
  const orders = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM ticket_orders
     WHERE event_id = ${eventId}::uuid AND status = 'pending' AND hold_expires_at <= ${now}
     ORDER BY hold_expires_at
     LIMIT ${SWEEP_BATCH}
       FOR UPDATE SKIP LOCKED`
  if (orders.length === 0) return false
  await expireOrders(tx, orders.map((o) => o.id))
  return true
}

function checkLine(type: LockedType | undefined, quantity: number, now: Date): LockedType {
  // A hidden type is not on sale to anyone holding its id (security H2): it reads as no such type.
  if (!type || type.hidden) throw new Refused("unknown_ticket_type")
  if ((type.sale_starts_at && type.sale_starts_at > now) || (type.sale_ends_at && type.sale_ends_at <= now)) throw new Refused("not_on_sale")
  if (quantity > type.max_per_order) throw new Refused("over_order_limit")
  if (type.sold + type.held + quantity > type.quantity) throw new Refused("sold_out")
  return type
}

/** The buyer's seats for the event that count against the cap, and their open holds. */
async function buyerStake(tx: Prisma.TransactionClient, eventId: string, buyerId: string, now: Date) {
  const [row] = await tx.$queryRaw<{ seats: number; pending: number }[]>`
    SELECT coalesce(sum(l.quantity), 0)::int AS seats,
           count(DISTINCT o.id) FILTER (WHERE o.status = 'pending')::int AS pending
      FROM ticket_orders o
      JOIN ticket_order_lines l ON l.order_id = o.id
     WHERE o.event_id = ${eventId}::uuid AND o.buyer_id = ${buyerId}
       AND (o.status = 'paid' OR (o.status = 'pending' AND o.hold_expires_at > ${now}))`
  return row
}

function priced(input: Parameters<typeof ticketFees>[0]): FeeBreakdown {
  try {
    return ticketFees(input)
  } catch (error) {
    if (error instanceof FeesExceedPriceError) throw new Refused("fees_exceed_price")
    throw error
  }
}

async function hold(tx: Prisma.TransactionClient, input: ReserveInput, age: number | null, now: Date) {
  await setLockTimeout(tx)
  // The event row first, shared (security review 7): an edit moving its times holds it FOR UPDATE and counts the
  // orders under that lock, so a hold and a time move never interleave. Before the types, as every writer that
  // locks both (the type writer, `saveTicketType`) takes the event first.
  await tx.$queryRaw`SELECT id FROM events WHERE id = ${input.eventId}::uuid AND kind = 'event' FOR SHARE`
  let types = await lockTypes(tx, input.eventId)
  const event = await sellingEvent(tx, input.eventId, age, now)
  if (await reclaimExpired(tx, input.eventId, now)) types = await lockTypes(tx, input.eventId)

  const byId = new Map(types.map((t) => [t.id, t]))
  const lines = input.lines.map((l) => ({ ...l, type: checkLine(byId.get(l.ticketTypeId), l.quantity, now) }))
  const ordered = lines.reduce((n, l) => n + l.quantity, 0)
  const stake = await buyerStake(tx, input.eventId, input.buyerId, now)
  if (stake.pending >= MAX_PENDING_PER_BUYER) throw new Refused("too_many_holds")
  if (stake.seats + ordered > MAX_SEATS_PER_BUYER) throw new Refused("too_many_seats")

  return writeHold(tx, input, lines, priceOf(event, types, lines), now)
}

/** The order's price, from the event's snapshot and the types' prices: the one pricing for a hold and a quote. */
function priceOf(
  event: { ticket_fee_schedule: Prisma.JsonValue; ticket_fee_rule: NonNullable<Awaited<ReturnType<typeof sellingEvent>>["ticket_fee_rule"]>; fees_absorbed: boolean },
  types: LockedType[],
  lines: PricedLine[]
): FeeBreakdown {
  const breakdown = priced({
    schedule: parseFeeSchedule(event.ticket_fee_schedule),
    // Sold only, never held: a hold is a buyer's say-so (lib/ticket-fees.ts, "Slabs").
    paidTicketsBefore: types.filter((t) => t.price_minor > 0).reduce((n, t) => n + t.sold, 0),
    lines: lines.map((l) => ({ ticketTypeId: l.ticketTypeId, unitPriceMinor: l.type.price_minor, quantity: l.quantity })),
    rule: event.ticket_fee_rule,
    feesAbsorbed: event.fees_absorbed,
  })
  const { totals } = breakdown
  // Free tickets are RSVP plus capacity and never an order (ticketing-business-model.md §4.4).
  if (totals.totalMinor === 0) throw new Refused("free_order")
  if (totals.totalMinor > MAX_ORDER_TOTAL_MINOR) throw new Refused("bad_lines")
  return breakdown
}

type PricedLine = ReserveInput["lines"][number] & { type: LockedType }

/** Hold the seats (one statement) and write the order with its lines. */
async function writeHold(tx: Prisma.TransactionClient, input: ReserveInput, lines: PricedLine[], breakdown: FeeBreakdown, now: Date) {
  const { totals } = breakdown
  await tx.$executeRaw`
    UPDATE ticket_types AS t SET held = t.held + v.quantity, updated_at = now()
      FROM unnest(${lines.map((l) => l.ticketTypeId)}::uuid[], ${lines.map((l) => l.quantity)}::int[]) AS v(id, quantity)
     WHERE t.id = v.id`
  const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000)
  /*
   * The one writer of an order, and so of its amounts. The payment phase
   * charges `total_minor` as read back from this row (in `currency`), never a
   * figure from the client or a recomputation: this is what the buyer was
   * shown. `subtotal_minor` and the lines come from the same `lines`, so the
   * subtotal is the lines' sum by construction (ticket-holds.itest.ts reads
   * both back); the CHECKs tie the total to its parts.
   */
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

/** Postgres gave up waiting for a row lock (55P03, `lock_timeout`). */
function isLockTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const meta = (error as { meta?: unknown }).meta
  const text = `${error instanceof Error ? error.message : ""}${JSON.stringify(meta ?? "")}`
  return text.includes("55P03") || text.includes("lock timeout")
}

/**
 * Reserve an order's quantities and write it `pending` with its fee breakdown,
 * all or nothing. A refusal is an answer, not an error; a broken fee snapshot
 * on the event throws (`TicketFeeError`), because that is ours to fix.
 *
 * The caller has authenticated `buyerId`. This decides the rest: the buyer is
 * not suspended or deleted, is old enough for the event (by birth date), the
 * event is on sale and not private, and the order fits every cap.
 */
export async function reserveTickets(input: ReserveInput): Promise<ReserveResult> {
  // Stateless first: a malformed order never takes a pooled connection (database 14).
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!wellFormed(input)) return { ok: false, reason: "bad_lines" }
  if (input.lines.reduce((n, l) => n + l.quantity, 0) > MAX_SEATS_PER_BUYER) return { ok: false, reason: "over_order_limit" }
  const buyer = await buyerAge(input.buyerId)
  if (!buyer) return { ok: false, reason: "buyer_not_allowed" }
  const door = await doorRefusal(input)
  if (door) return { ok: false, reason: door }

  const now = new Date()
  try {
    return await db.$transaction((tx) => hold(tx, input, buyer.age, now), TX)
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason }
    if (violatedConstraint(error, "ticket_types_not_oversold")) return { ok: false, reason: "sold_out" }
    if (isLockTimeout(error)) return { ok: false, reason: "busy" }
    throw error
  }
}

/**
 * Expire pending orders whose hold has run out and give their quantities back.
 * For the sweeper (lib/ticket-hold-sweeper.ts): safe to run concurrently and
 * repeatedly (`SKIP LOCKED`, and only `pending` orders move), one batch per
 * call. Works whether or not `TICKETING` is on, so a hold left when it went off
 * can still be given back.
 */
export async function releaseExpiredHolds(opts: { limit?: number } = {}): Promise<{ released: number }> {
  const limit = opts.limit ?? SWEEP_BATCH
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit is a positive integer")
  const now = new Date()
  return db.$transaction(async (tx) => {
    await setLockTimeout(tx)
    const orders = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM ticket_orders
       WHERE status = 'pending' AND hold_expires_at <= ${now}
       ORDER BY hold_expires_at
       LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`
    if (orders.length === 0) return { released: 0 }
    await expireOrders(tx, orders.map((o) => o.id))
    return { released: orders.length }
  }, TX)
}

export type QuoteResult = { ok: true; breakdown: FeeBreakdown; market: string } | { ok: false; reason: ReserveRefusal }

/**
 * What an order for these lines would cost now, with the same refusals as
 * `reserveTickets` less the hold count (nothing is held), and no lock and no
 * write: the app asks on every stepper change (contract §2). An order placed
 * after it is priced again, under the locks, and that price is the charge.
 */
export async function quoteTickets(input: ReserveInput): Promise<QuoteResult> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!wellFormed(input)) return { ok: false, reason: "bad_lines" }
  if (input.lines.reduce((n, l) => n + l.quantity, 0) > MAX_SEATS_PER_BUYER) return { ok: false, reason: "over_order_limit" }
  const buyer = await buyerAge(input.buyerId)
  if (!buyer) return { ok: false, reason: "buyer_not_allowed" }
  const door = await doorRefusal(input)
  if (door) return { ok: false, reason: door }
  const now = new Date()
  try {
    const [types, event] = await Promise.all([readTypes(input.eventId, now), sellingEvent(db, input.eventId, buyer.age, now)])
    const byId = new Map(types.map((t) => [t.id, t]))
    const lines = input.lines.map((l) => ({ ...l, type: checkLine(byId.get(l.ticketTypeId), l.quantity, now) }))
    const stake = await buyerStake(db, input.eventId, input.buyerId, now)
    if (stake.seats + lines.reduce((n, l) => n + l.quantity, 0) > MAX_SEATS_PER_BUYER) throw new Refused("too_many_seats")
    return { ok: true, breakdown: priceOf(event, types, lines), market: parseFeeSchedule(event.ticket_fee_schedule).market }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason }
    throw error
  }
}

/** Lock these pending orders (id order, waiting: the payment webhook takes an order the same way) and give them back as `cancelled`. */
async function cancelPending(where: Prisma.Sql): Promise<number> {
  return db.$transaction(async (tx) => {
    await setLockTimeout(tx)
    const orders = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM ticket_orders WHERE status = 'pending' AND ${where} ORDER BY id FOR UPDATE`
    if (orders.length === 0) return 0
    await expireOrders(tx, orders.map((o) => o.id), "cancelled")
    return orders.length
  }, TX)
}

/** Account deletion (security L3): the person's pending holds go back now, not in ten minutes. */
export const cancelBuyerHolds = (buyerId: string): Promise<number> => cancelPending(Prisma.sql`buyer_id = ${buyerId}`)

/** One order's hold, given back: its Razorpay order could not be created, so nobody can pay it. */
export const cancelHold = (orderId: string): Promise<number> => cancelPending(Prisma.sql`id = ${orderId}::uuid`)

/** A cancelled event's open holds, given back: nobody may pay for one now. */
export const cancelEventHolds = (eventId: string): Promise<number> => cancelPending(Prisma.sql`event_id = ${eventId}::uuid`)

/**
 * Would a hold for this order be granted now? For a payment that arrived after
 * its hold ran out (lib/ticket-payments.ts), under the caller's locks: the
 * order's row, then every type of the event in id order (the order a reserve
 * takes them in, so this cannot deadlock it). Every gate `hold` runs, against
 * now: the buyer's standing and the RSVP's door, the event still selling (and
 * not ended, not private, not under its minimum age), each line's type on sale
 * with room, and the buyer's seat cap. Null when it would be; the refusal when not.
 */
export async function lateSeatRefusal(tx: Prisma.TransactionClient, input: ReserveInput, now: Date): Promise<ReserveRefusal | null> {
  const buyer = await buyerAge(input.buyerId)
  if (!buyer) return "buyer_not_allowed"
  const door = await doorRefusal(input)
  if (door) return door
  try {
    const types = await lockTypes(tx, input.eventId)
    await sellingEvent(tx, input.eventId, buyer.age, now)
    const byId = new Map(types.map((t) => [t.id, t]))
    for (const l of input.lines) checkLine(byId.get(l.ticketTypeId), l.quantity, now)
    const stake = await buyerStake(tx, input.eventId, input.buyerId, now)
    if (stake.seats + input.lines.reduce((n, l) => n + l.quantity, 0) > MAX_SEATS_PER_BUYER) throw new Refused("too_many_seats")
    return null
  } catch (error) {
    if (error instanceof Refused) return error.reason
    throw error
  }
}
