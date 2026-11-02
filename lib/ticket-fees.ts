import { z } from "zod"

/**
 * The booking fee on a ticket order (ticketing-business-model.md §2).
 *
 * Pure and client-safe: no database, no secrets, no clock. The caller hands
 * over the event's fee snapshot, how many paid tickets the event has already
 * counted, the order's lines, the organisation's plan and its founding-offer
 * state, and gets every amount back in integer minor units (paise, cents).
 *
 * ## The one rounding rule
 *
 * Every part is computed **per ticket** and rounded **half up to the minor
 * unit**, once: the service fee, then the tax on that rounded fee, then
 * processing on the rounded amounts. A line's and an order's figures are sums
 * of those per-ticket integers, so the parts add up to the total exactly, and
 * refunding one ticket returns exactly that ticket's fee.
 *
 * The doc's concert example (₹73,451) is the unrounded sum; per ticket it is
 * ₹73,453 (3.5% of ₹1,499 is ₹52.465, which is ₹52.47). Its mixer example
 * (₹9,589) is already the per-ticket figure, and so are the meetup, open-mic
 * and ₹499 buyer-view figures: no single rule reproduces both ₹9,589 and
 * ₹73,451, and this one reproduces everything else in the doc.
 *
 * ## Slabs
 *
 * Marginal per event, like tax slabs: ticket N of the event pays the rate of
 * the slab N falls in. Only paid tickets are numbered (a free ticket carries
 * no fee and does not move the event up a slab). Within an order, tickets are
 * numbered line by line in the order given. Pro starts one slab lower. The
 * founding offer is a flat rate, or the slab's rate where that is lower; the
 * per-ticket minimum applies under every rule.
 */

export const FEE_SCHEDULE_VERSION = 1

/** The founding offer: an organisation's first three ticketed events at 2%, if ticketing went on by 31 March 2027 (IST). */
export const FOUNDING_OFFER_BPS = 200
export const FOUNDING_OFFER_EVENTS = 3
export const FOUNDING_OFFER_ENDS_AT = new Date("2027-04-01T00:00:00+05:30")

const BPS_SCALE = 10_000

export class TicketFeeError extends Error {}

const bps = z.number().int().min(0).max(BPS_SCALE)
const minor = z.number().int().min(0)

const scheduleSchema = z
  .object({
    version: z.literal(FEE_SCHEDULE_VERSION),
    market: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    slabs: z.array(z.object({ fromTicket: z.number().int().min(1), bps })).min(1),
    minFeeMinor: minor,
    serviceTaxBps: bps,
    processingBps: bps,
    takenAt: z.string().datetime(),
  })
  .strict()
  .refine((s) => s.slabs[0].fromTicket === 1, "the first slab starts at ticket 1")
  .refine((s) => s.slabs.every((slab, i) => i === 0 || slab.fromTicket > s.slabs[i - 1].fromTicket), "slabs are in ascending order")

/** What `events.ticket_fee_schedule` holds: the market's rates when ticketing went on. */
export type FeeSchedule = z.infer<typeof scheduleSchema>

/** Read a stored snapshot. Throws on anything that is not one, rather than charging from a guess. */
export function parseFeeSchedule(value: unknown): FeeSchedule {
  const parsed = scheduleSchema.safeParse(value)
  if (!parsed.success) throw new TicketFeeError(`not a fee schedule: ${parsed.error.issues[0]?.message ?? "invalid"}`)
  return parsed.data
}

/** The `markets` columns a snapshot is taken from. */
export interface MarketFeeRow {
  code: string
  currency: string
  ticketing_mode: "off" | "native" | "external"
  ticket_fee_slab_from: number[]
  ticket_fee_slab_bps: number[]
  ticket_fee_min_minor: number
  ticket_fee_tax_bps: number
  ticket_processing_bps: number
}

/** The snapshot of a market's rates, taken when an event turns ticketing on. */
export function feeScheduleFromMarket(row: MarketFeeRow, takenAt: Date): FeeSchedule {
  if (row.ticket_fee_slab_from.length !== row.ticket_fee_slab_bps.length) {
    throw new TicketFeeError(`market ${row.code}: slab thresholds and rates differ in length`)
  }
  return parseFeeSchedule({
    version: FEE_SCHEDULE_VERSION,
    market: row.code,
    currency: row.currency,
    slabs: row.ticket_fee_slab_from.map((fromTicket, i) => ({ fromTicket, bps: row.ticket_fee_slab_bps[i] })),
    minFeeMinor: row.ticket_fee_min_minor,
    serviceTaxBps: row.ticket_fee_tax_bps,
    processingBps: row.ticket_processing_bps,
    takenAt: takenAt.toISOString(),
  })
}

export interface FoundingOfferState {
  /** Events of this organisation that turned ticketing on before this one. */
  ticketedEventsBefore: number
  /** When this event turned ticketing on. */
  enabledAt: Date
}

export function foundingOfferApplies(state: FoundingOfferState): boolean {
  return state.ticketedEventsBefore < FOUNDING_OFFER_EVENTS && state.enabledAt.getTime() < FOUNDING_OFFER_ENDS_AT.getTime()
}

export interface FeeLineInput {
  ticketTypeId: string
  unitPriceMinor: number
  quantity: number
}

export interface FeeInput {
  schedule: FeeSchedule
  /** Paid tickets the event has already numbered (sold, and held under the lock). */
  paidTicketsBefore: number
  lines: FeeLineInput[]
  /** An organisation on a paid Analytics or Venue Pro plan. */
  pro: boolean
  founding: FoundingOfferState
  feesAbsorbed: boolean
}

export interface PerTicketFees {
  serviceFeeMinor: number
  serviceFeeTaxMinor: number
  processingFeeMinor: number
}

/** A run of tickets in one line at one rate. */
export interface FeeSegment {
  quantity: number
  bps: number
  perTicket: PerTicketFees
  serviceFeeMinor: number
  serviceFeeTaxMinor: number
  processingFeeMinor: number
}

export interface FeeLine extends FeeLineInput {
  segments: FeeSegment[]
  subtotalMinor: number
  serviceFeeMinor: number
  serviceFeeTaxMinor: number
  processingFeeMinor: number
  /** What the buyer pays on top of the price: zero when the organiser absorbs. */
  bookingFeeMinor: number
  /** What the buyer pays for the line. */
  totalMinor: number
  organizerPayoutMinor: number
}

export interface FeeTotals {
  subtotalMinor: number
  serviceFeeMinor: number
  serviceFeeTaxMinor: number
  processingFeeMinor: number
  bookingFeeMinor: number
  totalMinor: number
  organizerPayoutMinor: number
}

export interface FeeBreakdown {
  version: typeof FEE_SCHEDULE_VERSION
  currency: string
  rule: "standard" | "pro" | "founding"
  feesAbsorbed: boolean
  paidTicketsBefore: number
  paidTicketsAfter: number
  lines: FeeLine[]
  totals: FeeTotals
}

/** `amount × rate`, rounded half up. Inputs are non-negative integers; refuses a product past exact range. */
function ofBps(amount: number, rate: number): number {
  const product = amount * rate
  if (!Number.isSafeInteger(product)) throw new TicketFeeError("amount too large to price exactly")
  return Math.floor((product + BPS_SCALE / 2) / BPS_SCALE)
}

function slabIndex(schedule: FeeSchedule, ticketNumber: number): number {
  let index = 0
  schedule.slabs.forEach((slab, i) => {
    if (ticketNumber >= slab.fromTicket) index = i
  })
  return index
}

function rateFor(input: FeeInput, rule: FeeBreakdown["rule"], ticketNumber: number): number {
  const { slabs } = input.schedule
  const index = slabIndex(input.schedule, ticketNumber)
  if (rule === "founding") return Math.min(FOUNDING_OFFER_BPS, slabs[index].bps)
  if (rule === "pro") return slabs[Math.min(index + 1, slabs.length - 1)].bps
  return slabs[index].bps
}

function perTicket(input: FeeInput, priceMinor: number, rate: number): PerTicketFees {
  const { schedule, feesAbsorbed } = input
  const serviceFeeMinor = Math.max(ofBps(priceMinor, rate), schedule.minFeeMinor)
  const serviceFeeTaxMinor = ofBps(serviceFeeMinor, schedule.serviceTaxBps)
  // Processing is at cost on what the buyer is charged: the price, plus the fee and its tax when the buyer pays them.
  const charged = feesAbsorbed ? priceMinor : priceMinor + serviceFeeMinor + serviceFeeTaxMinor
  const processingFeeMinor = ofBps(charged, schedule.processingBps)
  if (feesAbsorbed && serviceFeeMinor + serviceFeeTaxMinor + processingFeeMinor > priceMinor) {
    throw new TicketFeeError("the fees on this price exceed it, so they cannot be absorbed")
  }
  return { serviceFeeMinor, serviceFeeTaxMinor, processingFeeMinor }
}

const ZERO: PerTicketFees = { serviceFeeMinor: 0, serviceFeeTaxMinor: 0, processingFeeMinor: 0 }

function segment(quantity: number, rate: number, fees: PerTicketFees): FeeSegment {
  return {
    quantity,
    bps: rate,
    perTicket: fees,
    serviceFeeMinor: fees.serviceFeeMinor * quantity,
    serviceFeeTaxMinor: fees.serviceFeeTaxMinor * quantity,
    processingFeeMinor: fees.processingFeeMinor * quantity,
  }
}

/** Split a paid line into runs at one rate each: the tickets numbered `first`..`first + quantity - 1`. */
function segmentsFor(input: FeeInput, rule: FeeBreakdown["rule"], line: FeeLineInput, first: number): FeeSegment[] {
  if (line.unitPriceMinor === 0) return [segment(line.quantity, 0, ZERO)]
  const runs: FeeSegment[] = []
  let ticket = first
  const last = first + line.quantity - 1
  while (ticket <= last) {
    const rate = rateFor(input, rule, ticket)
    const next = input.schedule.slabs[slabIndex(input.schedule, ticket) + 1]
    const runEnd = next ? Math.min(last, next.fromTicket - 1) : last
    const count = runEnd - ticket + 1
    const previous = runs[runs.length - 1]
    // Pro and founding can give two slabs one rate: one run, not two.
    if (previous && previous.bps === rate) runs[runs.length - 1] = segment(previous.quantity + count, rate, previous.perTicket)
    else runs.push(segment(count, rate, perTicket(input, line.unitPriceMinor, rate)))
    ticket = runEnd + 1
  }
  return runs
}

function lineFrom(input: FeeInput, line: FeeLineInput, segments: FeeSegment[]): FeeLine {
  const sum = (k: "serviceFeeMinor" | "serviceFeeTaxMinor" | "processingFeeMinor") => segments.reduce((s, g) => s + g[k], 0)
  const subtotalMinor = line.unitPriceMinor * line.quantity
  const serviceFeeMinor = sum("serviceFeeMinor")
  const serviceFeeTaxMinor = sum("serviceFeeTaxMinor")
  const processingFeeMinor = sum("processingFeeMinor")
  const fees = serviceFeeMinor + serviceFeeTaxMinor + processingFeeMinor
  const bookingFeeMinor = input.feesAbsorbed ? 0 : fees
  return {
    ...line,
    segments,
    subtotalMinor,
    serviceFeeMinor,
    serviceFeeTaxMinor,
    processingFeeMinor,
    bookingFeeMinor,
    totalMinor: subtotalMinor + bookingFeeMinor,
    organizerPayoutMinor: input.feesAbsorbed ? subtotalMinor - fees : subtotalMinor,
  }
}

function validate(input: FeeInput): void {
  if (!Number.isInteger(input.paidTicketsBefore) || input.paidTicketsBefore < 0) {
    throw new TicketFeeError("paidTicketsBefore must be a non-negative integer")
  }
  if (input.lines.length === 0) throw new TicketFeeError("an order has at least one line")
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.unitPriceMinor) || l.unitPriceMinor < 0) throw new TicketFeeError("a price is a non-negative integer in minor units")
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) throw new TicketFeeError("a quantity is a positive integer")
    if (!Number.isSafeInteger(l.unitPriceMinor * l.quantity)) throw new TicketFeeError("amount too large to price exactly")
  }
}

export function ticketFees(input: FeeInput): FeeBreakdown {
  validate(input)
  const rule: FeeBreakdown["rule"] = foundingOfferApplies(input.founding) ? "founding" : input.pro ? "pro" : "standard"
  let numbered = input.paidTicketsBefore
  const lines = input.lines.map((line) => {
    const segments = segmentsFor(input, rule, line, numbered + 1)
    if (line.unitPriceMinor > 0) numbered += line.quantity
    return lineFrom(input, line, segments)
  })
  const total = (k: keyof FeeTotals) => lines.reduce((s, l) => s + l[k], 0)
  return {
    version: FEE_SCHEDULE_VERSION,
    currency: input.schedule.currency,
    rule,
    feesAbsorbed: input.feesAbsorbed,
    paidTicketsBefore: input.paidTicketsBefore,
    paidTicketsAfter: numbered,
    lines,
    totals: {
      subtotalMinor: total("subtotalMinor"),
      serviceFeeMinor: total("serviceFeeMinor"),
      serviceFeeTaxMinor: total("serviceFeeTaxMinor"),
      processingFeeMinor: total("processingFeeMinor"),
      bookingFeeMinor: total("bookingFeeMinor"),
      totalMinor: total("totalMinor"),
      organizerPayoutMinor: total("organizerPayoutMinor"),
    },
  }
}
