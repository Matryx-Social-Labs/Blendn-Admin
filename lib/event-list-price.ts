import { db } from "@/lib/db"
import { ticketingOn } from "@/lib/env"

/**
 * What a list row may say about tickets (the Pulse's rows, Flow 3b · N1, SCRUM-1022): `ticketed`, and `fromPrice`
 * only when a ticket is really for sale. The event page's own rule (`lib/ticket-views.ts`, `fromMinor`) for one
 * event, here for a page of them in one query:
 *
 * - `native`: the lowest price among types that are listed (not `hidden`), not free, inside their sale window,
 *   with seats left, on an event that has not ended. Free-only or nothing on sale: ticketed, no price.
 * - `external`: ticketed, never a price (it is the organiser's page, not ours).
 * - `off`, or ticketing off on this deployment (`TICKETING`): not ticketed.
 *
 * Never a hidden tier's price, and never "From ₹0".
 */
export interface ListPrice {
  ticketed: boolean
  fromPrice: { minor: number; currency: string } | null
}

type PricedEvent = { ticketing_mode: string; ticket_fee_schedule: unknown; end_time: Date }
type PricedType = {
  price_minor: number
  quantity: number
  sold: number
  held: number
  hidden: boolean
  sale_starts_at: Date | null
  sale_ends_at: Date | null
}

const NONE: ListPrice = { ticketed: false, fromPrice: null }

export function listPrice(event: PricedEvent, types: readonly PricedType[], now: Date, on: boolean): ListPrice {
  if (!on || event.ticketing_mode === "off") return NONE
  if (event.ticketing_mode !== "native" || event.end_time <= now) return { ticketed: true, fromPrice: null }
  const onSale = types.filter(
    (t) =>
      !t.hidden &&
      t.price_minor > 0 &&
      t.quantity - t.sold - t.held > 0 &&
      (!t.sale_starts_at || t.sale_starts_at <= now) &&
      (!t.sale_ends_at || t.sale_ends_at > now)
  )
  const currency = currencyOf(event.ticket_fee_schedule)
  if (!onSale.length || !currency) return { ticketed: true, fromPrice: null }
  return { ticketed: true, fromPrice: { minor: Math.min(...onSale.map((t) => t.price_minor)), currency } }
}

/**
 * The schedule's currency, read without validating the rest: one malformed snapshot must cost its row a price, never
 * the whole list (`parseFeeSchedule` throws, which is right at checkout and wrong in a feed).
 */
function currencyOf(schedule: unknown): string | null {
  const c = (schedule as { currency?: unknown } | null)?.currency
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null
}

/** One page's prices, by event id: one query, and none at all when no event on the page sells natively. */
export async function listPrices(
  events: readonly ({ id: string } & PricedEvent)[],
  now: Date = new Date()
): Promise<Map<string, ListPrice>> {
  const on = ticketingOn()
  const native = on ? events.filter((e) => e.ticketing_mode === "native").map((e) => e.id) : []
  const types = native.length
    ? await db.ticket_types.findMany({
        where: { event_id: { in: native }, hidden: false },
        select: { event_id: true, price_minor: true, quantity: true, sold: true, held: true, hidden: true, sale_starts_at: true, sale_ends_at: true },
      })
    : []
  const byEvent = new Map<string, PricedType[]>()
  for (const t of types) byEvent.set(t.event_id, [...(byEvent.get(t.event_id) ?? []), t])
  return new Map(events.map((e) => [e.id, listPrice(e, byEvent.get(e.id) ?? [], now, on)]))
}
