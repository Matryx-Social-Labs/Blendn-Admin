import type { Prisma, user_role } from "@prisma/client"
import { z } from "zod"

import { isUuid } from "./api-input"
import { auditInTx } from "./audit-log"
import { db } from "./db"
import { ticketingOn } from "./env"
import { wallClockToUtc } from "./event-wall-clock"
import { actorFor } from "./org-membership"
import { violatedConstraint } from "./prisma-errors"
import { eventPermissionSelect, eventPermissions } from "./rbac"

/**
 * The ticket types writer (SCRUM-1014; contract §8.10, §8.11): the dashboard's
 * one door onto `ticket_types`.
 *
 * - Whoever may edit the event (`eventPermissions(...).canEdit` on
 *   `actorFor`: its organization, never `organizer_id`), and only once it
 *   sells natively, so a type never exists before the terms were accepted.
 * - At most `TICKET_TYPES_MAX` an event, hidden ones counted. The event row is
 *   locked (`FOR NO KEY UPDATE`: two writers queue, a buyer's order insert,
 *   which only takes a key share, does not) before the count, so two saves
 *   cannot both be the twenty-first.
 * - Never free: free is RSVP plus `max_capacity`, and makes no order (§8.11).
 * - A quantity never under what is sold and held (the type row is locked, and
 *   `ticket_types_not_oversold` is the last word against a buyer mid-order).
 * - A price change applies to new orders only: a sold order keeps its own
 *   `unit_price_minor` and `total_minor`, so nothing here can reach it. The
 *   change is recorded (`ticket_type.price_changed`), with what was sold.
 */

export const TICKET_TYPES_MAX = 20
/** What a buyer may hold for one event at all (`reserveTickets`'s cap), so no type offers more an order. */
export const MAX_PER_ORDER_CAP = 10
/** Ten lakh rupees, in paise: a price past this is a typo. */
const PRICE_MAX_MINOR = 100_000_000
const QUANTITY_MAX = 100_000
const TX = { maxWait: 10_000, timeout: 15_000 }

export type TypeRefusal = "ticketing_off" | "not_found" | "not_authorized" | "not_selling" | "cap_reached" | "invalid" | "below_sold"
export type SaveTypeResult = { ok: true; id: string } | { ok: false; reason: TypeRefusal; message: string }

const SENTENCE: Record<TypeRefusal, string> = {
  ticketing_off: "Ticket selling is not available.",
  not_found: "That ticket type is not on this event.",
  not_authorized: "Only the organization running this event can change its tickets.",
  not_selling: "Turn on ticket selling before adding ticket types.",
  cap_reached: `An event has at most ${TICKET_TYPES_MAX} ticket types. Take one off sale and edit it instead.`,
  invalid: "Check the highlighted fields.",
  below_sold: "The quantity can’t be less than what is already sold or being bought.",
}

const refuse = (reason: TypeRefusal, message = SENTENCE[reason]): SaveTypeResult => ({ ok: false, reason, message })

/** "1,499", "1499.5", "₹ 1,499.00" → paise. Anything else, or nothing, is not a price. */
export function priceToMinor(raw: string): number | null {
  const s = raw.replace(/[₹,\s]/g, "")
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null
  const [whole, frac = ""] = s.split(".")
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"))
}

const count = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/[,\s]/g, ""))
    .pipe(z.string().regex(/^\d+$/, "a whole number").transform(Number).pipe(z.number().int().min(1).max(max)))

const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/** The form as the browser posts it: every field a string. */
const formSchema = z.object({
  id: z.string().refine(isUuid).optional(),
  name: z.string().trim().min(1, "Give it a name").max(80),
  price: z.string().max(20),
  quantity: count(QUANTITY_MAX),
  maxPerOrder: count(MAX_PER_ORDER_CAP),
  salesStart: z.string().refine((s) => s === "" || LOCAL.test(s)),
  salesEnd: z.string().refine((s) => s === "" || LOCAL.test(s)),
  /** A checkbox: "on" when ticked. Off sale is `hidden`: not listed, not sold. */
  onSale: z.string().optional(),
})

export type TicketTypeForm = z.input<typeof formSchema>

interface Parsed {
  id?: string
  name: string
  priceMinor: number
  quantity: number
  maxPerOrder: number
  saleStartsAt: Date | null
  saleEndsAt: Date | null
  hidden: boolean
}

function parse(input: unknown, timezone: string): Parsed | string {
  const form = formSchema.safeParse(input)
  if (!form.success) return form.error.issues[0]?.message ?? SENTENCE.invalid
  const f = form.data
  const priceMinor = priceToMinor(f.price)
  if (priceMinor === null || priceMinor < 1 || priceMinor > PRICE_MAX_MINOR) return "A ticket type needs a price. Free tickets are “I’m going” with a capacity."
  const saleStartsAt = f.salesStart ? new Date(wallClockToUtc(f.salesStart, timezone)) : null
  const saleEndsAt = f.salesEnd ? new Date(wallClockToUtc(f.salesEnd, timezone)) : null
  if (saleStartsAt && saleEndsAt && saleStartsAt >= saleEndsAt) return "Sales end after they start."
  return { id: f.id, name: f.name, priceMinor, quantity: f.quantity, maxPerOrder: f.maxPerOrder, saleStartsAt, saleEndsAt, hidden: f.onSale !== "on" }
}

class Refused extends Error {
  constructor(readonly result: SaveTypeResult) {
    super("refused")
  }
}

async function write(tx: Prisma.TransactionClient, eventId: string, userId: string, input: unknown, mayEdit: (e: Prisma.eventsGetPayload<{ select: typeof eventPermissionSelect }>) => boolean) {
  await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid AND kind = 'event' FOR NO KEY UPDATE`
  const event = await tx.events.findUnique({
    where: { id: eventId },
    select: { ...eventPermissionSelect, deleted_at: true, ticketing_mode: true, timezone: true },
  })
  if (!event || event.deleted_at) throw new Refused(refuse("not_found"))
  if (!mayEdit(event)) throw new Refused(refuse("not_authorized"))
  if (event.ticketing_mode !== "native") throw new Refused(refuse("not_selling"))
  const parsed = parse(input, event.timezone)
  if (typeof parsed === "string") throw new Refused(refuse("invalid", parsed))
  const orgId = event.organizer_org_id
  const data = {
    name: parsed.name,
    price_minor: parsed.priceMinor,
    quantity: parsed.quantity,
    max_per_order: parsed.maxPerOrder,
    sale_starts_at: parsed.saleStartsAt,
    sale_ends_at: parsed.saleEndsAt,
    hidden: parsed.hidden,
  }

  if (!parsed.id) {
    const existing = await tx.ticket_types.count({ where: { event_id: eventId } })
    if (existing >= TICKET_TYPES_MAX) throw new Refused(refuse("cap_reached"))
    const row = await tx.ticket_types.create({ data: { ...data, event_id: eventId, sort: existing }, select: { id: true } })
    await auditInTx(tx, { userId, action: "ticket_type.created", resource: "event", resourceId: eventId, orgId, details: { ticketTypeId: row.id, priceMinor: data.price_minor, quantity: data.quantity } })
    return row.id
  }

  const [before] = await tx.$queryRaw<{ price_minor: number; sold: number; held: number; event_id: string }[]>`
    SELECT price_minor, sold, held, event_id::text FROM ticket_types WHERE id = ${parsed.id}::uuid FOR UPDATE`
  if (!before || before.event_id !== eventId) throw new Refused(refuse("not_found"))
  if (parsed.quantity < before.sold + before.held) throw new Refused(refuse("below_sold", `At least ${before.sold + before.held}: that many are sold or being bought.`))
  await tx.ticket_types.update({ where: { id: parsed.id }, data })
  if (before.price_minor !== data.price_minor) {
    await auditInTx(tx, {
      userId,
      action: "ticket_type.price_changed",
      resource: "ticket_type",
      resourceId: parsed.id,
      orgId,
      details: { eventId, fromMinor: before.price_minor, toMinor: data.price_minor, sold: before.sold, held: before.held },
    })
  }
  return parsed.id
}

/** Create (no `id`) or edit a ticket type from the dashboard's form. */
export async function saveTicketType(eventId: string, user: { id: string; role: user_role }, input: unknown): Promise<SaveTypeResult> {
  if (!ticketingOn()) return refuse("ticketing_off")
  if (!isUuid(eventId)) return refuse("not_found")
  const actor = await actorFor(user)
  try {
    const id = await db.$transaction((tx) => write(tx, eventId, user.id, input, (e) => eventPermissions(actor, e).canEdit), TX)
    return { ok: true, id }
  } catch (error) {
    if (error instanceof Refused) return error.result
    // A buyer took the last seats between the read and the write: the CHECK is the last word.
    if (violatedConstraint(error, "ticket_types_not_oversold")) return refuse("below_sold")
    throw error
  }
}
