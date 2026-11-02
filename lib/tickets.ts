import { createHmac, randomInt, timingSafeEqual } from "node:crypto"

import type { Prisma, user_role } from "@prisma/client"

import { isUuid } from "./api-input"
import { db } from "./db"
import { ticketQrKey, ticketingOn } from "./env"
import { actorFor } from "./org-membership"
import { violatedConstraint } from "./prisma-errors"
import { eventPermissionSelect, eventPermissions } from "./rbac"

/**
 * Tickets: what the buyer shows at the door, and the door's one write
 * (SCRUM-1010, security H5, database 6).
 *
 * A ticket carries two credentials. The **door code** is six characters a
 * person reads aloud or types, random and unique per event. The **QR** is
 * `<ticket id>.<base64url HMAC-SHA256(TICKET_QR_KEY, ticket id)>`, derived on
 * demand and stored nowhere: the server can show it again after a reinstall
 * or on a new phone, and a copy of the table is not a copy of every pass.
 *
 * Issuing is Phase 2's (the webhook marks an order paid and issues its tickets
 * in that transaction; `tickets_order_must_be_paid` refuses one for any order
 * that is not paid). `issueTickets` is the skeleton of that step, here so the
 * code and secret rules are tested where they are written.
 */

/** Crockford base32 less 0 O 1 I L U: nothing a tired door can misread. CHECK `tickets_door_code_shape` matches. */
export const DOOR_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
export const DOOR_CODE_LENGTH = 6
/** Collisions in 30^6 codes per event are rare; this many in a row is a broken generator, not bad luck. */
const DOOR_CODE_ATTEMPTS = 8
const DOOR_CODE_INDEX = "tickets_event_id_door_code_key"

/** Uniform per character: `randomInt` rejects the modulo bias a `byte % 30` would carry. */
export function newDoorCode(): string {
  let code = ""
  for (let i = 0; i < DOOR_CODE_LENGTH; i++) code += DOOR_CODE_ALPHABET[randomInt(DOOR_CODE_ALPHABET.length)]
  return code
}

const qrMac = (ticketId: string): Buffer => createHmac("sha256", ticketQrKey()).update(ticketId, "utf8").digest()

/** What a ticket's QR encodes. Derived, so the wallet, a reinstall and the email all get the same one. */
export function ticketQrPayload(ticketId: string): string {
  if (!isUuid(ticketId)) throw new TypeError("a ticket id is a uuid")
  return `${ticketId}.${qrMac(ticketId).toString("base64url")}`
}

/**
 * The ticket a scanned QR names, or null if it is not one we signed. The MAC
 * is recomputed and compared in constant time, so how much of a forgery
 * matched never shows in the response time.
 */
export function verifyTicketQr(payload: string): string | null {
  const [ticketId, mac, extra] = typeof payload === "string" ? payload.split(".") : []
  if (!isUuid(ticketId) || !mac || extra !== undefined) return null
  const presented = Buffer.from(mac, "base64url")
  const expected = qrMac(ticketId)
  return presented.length === expected.length && timingSafeEqual(presented, expected) ? ticketId : null
}

export interface IssuedTicket {
  ticketId: string
  doorCode: string
  /** `ticketQrPayload(ticketId)`: the same every time it is asked for. */
  qrPayload: string
}

/**
 * Issue an order's tickets, one per seat, inside the transaction that marked
 * it paid. A door code already used at the event is drawn again; the retry is
 * keyed on that index's name (P2002 carries no `meta.target` here, so
 * `violatedConstraint`), and a savepoint keeps the transaction usable after
 * the refused insert.
 *
 * Phase 2 owns fulfilment (the RSVP, the email, the push); this is the part
 * whose rules are ours.
 */
export async function issueTickets(tx: Prisma.TransactionClient, orderId: string): Promise<IssuedTicket[]> {
  const order = await tx.ticket_orders.findUniqueOrThrow({
    where: { id: orderId },
    select: { event_id: true, buyer_id: true, lines: { select: { ticket_type_id: true, quantity: true }, orderBy: { ticket_type_id: "asc" } } },
  })
  const issued: IssuedTicket[] = []
  for (const line of order.lines) {
    for (let seat = 0; seat < line.quantity; seat++) {
      issued.push(await issueOne(tx, { orderId, eventId: order.event_id, holderId: order.buyer_id, ticketTypeId: line.ticket_type_id }))
    }
  }
  return issued
}

async function issueOne(
  tx: Prisma.TransactionClient,
  seat: { orderId: string; eventId: string; holderId: string; ticketTypeId: string }
): Promise<IssuedTicket> {
  for (let attempt = 1; ; attempt++) {
    const doorCode = newDoorCode()
    await tx.$executeRaw`SAVEPOINT door_code`
    try {
      const row = await tx.tickets.create({
        data: {
          order_id: seat.orderId,
          event_id: seat.eventId,
          ticket_type_id: seat.ticketTypeId,
          holder_id: seat.holderId,
          door_code: doorCode,
        },
        select: { id: true },
      })
      await tx.$executeRaw`RELEASE SAVEPOINT door_code`
      return { ticketId: row.id, doorCode, qrPayload: ticketQrPayload(row.id) }
    } catch (error) {
      if (!violatedConstraint(error, DOOR_CODE_INDEX) || attempt >= DOOR_CODE_ATTEMPTS) throw error
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT door_code`
    }
  }
}

export type RedeemCredential = { doorCode: string } | { qr: string }

export type RedeemResult =
  | { ok: true; ticketId: string; redeemedAt: Date }
  | { ok: false; reason: "ticketing_off" | "not_authorized" | "invalid" | "already_redeemed"; redeemedAt?: Date }

async function ticketFor(eventId: string, credential: RedeemCredential): Promise<string | null> {
  if ("doorCode" in credential) {
    const code = typeof credential.doorCode === "string" ? credential.doorCode.trim().toUpperCase() : ""
    if (code.length !== DOOR_CODE_LENGTH) return null
    const row = await db.tickets.findUnique({ where: { event_id_door_code: { event_id: eventId, door_code: code } }, select: { id: true } })
    return row?.id ?? null
  }
  const ticketId = verifyTicketQr(credential.qr)
  if (!ticketId) return null
  const row = await db.tickets.findUnique({ where: { id: ticketId }, select: { event_id: true } })
  return row?.event_id === eventId ? ticketId : null
}

/**
 * Let a ticket in, once. Only someone who operates the event (`canOperate`:
 * its organisation, the venue it is held at, an admin) may.
 *
 * The write is one conditional UPDATE — not redeemed yet, and its order still
 * paid — and its row count is the answer, so two scanners at two doors cannot
 * both let one ticket in.
 *
 * TODO(ticketing Phase 4, SCRUM-1007): the door route ("Check tickets") rate
 * limits this per operator and event before calling it; six characters from
 * thirty is guessable at an unlimited door.
 */
export async function redeemTicket(input: {
  eventId: string
  user: { id: string; role: user_role }
  credential: RedeemCredential
}): Promise<RedeemResult> {
  if (!ticketingOn()) return { ok: false, reason: "ticketing_off" }
  if (!isUuid(input.eventId)) return { ok: false, reason: "invalid" }
  const event = await db.events.findUnique({ where: { id: input.eventId }, select: eventPermissionSelect })
  if (!event || !eventPermissions(await actorFor(input.user), event).canOperate) return { ok: false, reason: "not_authorized" }

  const ticketId = await ticketFor(input.eventId, input.credential)
  if (!ticketId) return { ok: false, reason: "invalid" }

  const [admitted] = await db.$queryRaw<{ redeemed_at: Date }[]>`
    UPDATE tickets AS t SET redeemed_at = now(), redeemed_by = ${input.user.id}
     WHERE t.id = ${ticketId}::uuid AND t.redeemed_at IS NULL
       AND EXISTS (SELECT 1 FROM ticket_orders o WHERE o.id = t.order_id AND o.status = 'paid')
    RETURNING t.redeemed_at`
  if (admitted) return { ok: true, ticketId, redeemedAt: admitted.redeemed_at }

  const ticket = await db.tickets.findUnique({ where: { id: ticketId }, select: { redeemed_at: true } })
  return ticket?.redeemed_at ? { ok: false, reason: "already_redeemed", redeemedAt: ticket.redeemed_at } : { ok: false, reason: "invalid" }
}
