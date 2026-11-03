import type { user_role } from "@prisma/client"

import { isUuid } from "./api-input"
import { db } from "./db"
import { ticketingOn } from "./env"
import { actorFor } from "./org-membership"
import { hit } from "./rate-limit-store"
import { eventPermissionSelect, eventPermissions } from "./rbac"
import { DOOR_CODE_LENGTH, redeemTicket, verifyTicketQr, type RedeemCredential } from "./tickets"

/**
 * "Check tickets", the door (SCRUM-1014): what an operator's phone sends and
 * is told back. The write is `redeemTicket`'s, one conditional UPDATE, so the
 * sixth character or a scan admits in one step and two doors never both let
 * one ticket in. What the door is told is a code, a ticket type and a time,
 * never a person.
 *
 * Six characters of thirty are guessable at an unlimited door, so every
 * attempt by an operator counts against two limits before any ticket is
 * looked up: one per operator at this event, and a ceiling for the event
 * across all its doors. Only an operator's attempts count, so nobody else
 * can spend an event's ceiling.
 * The ceiling is sized for a big door (ten phones at a steady thirty) and
 * still bounds a farm of staff accounts guessing together.
 */

export const DOOR_PER_ACTOR_PER_MINUTE = 30
export const DOOR_PER_EVENT_PER_MINUTE = 300
const MINUTE_MS = 60_000

export type DoorCredential = { code: string } | { qr: string }

export type DoorAnswer =
  | { kind: "let_in"; code: string; typeName: string; nth: number; of: number; at: Date }
  | { kind: "used"; code: string; typeName: string; at: Date }
  | { kind: "invalid"; code: string | null }
  | { kind: "wait"; retryAfter: number }
  | { kind: "not_authorized" }
  | { kind: "off" }

/** The code as the door shows it: upper case, no spaces, or null when it cannot be a code. */
function cleanCode(raw: string): string | null {
  const code = typeof raw === "string" ? raw.replace(/\s/g, "").toUpperCase() : ""
  return code.length === DOOR_CODE_LENGTH ? code : null
}

async function overLimit(eventId: string, userId: string): Promise<number | null> {
  const now = Date.now()
  const mine = await hit(`rl:door:${eventId}:${userId}`, MINUTE_MS)
  if (mine.count > DOOR_PER_ACTOR_PER_MINUTE) return Math.max(1, Math.ceil((mine.resetAt - now) / 1000))
  const all = await hit(`rl:door-event:${eventId}`, MINUTE_MS)
  if (all.count > DOOR_PER_EVENT_PER_MINUTE) return Math.max(1, Math.ceil((all.resetAt - now) / 1000))
  return null
}

/** The ticket a credential names at this event, for the answer's code and type: after the write, never instead of it. */
async function ticketOf(eventId: string, credential: DoorCredential) {
  const where = "code" in credential ? { event_id_door_code: { event_id: eventId, door_code: cleanCode(credential.code) ?? "" } } : null
  const id = "qr" in credential ? verifyTicketQr(credential.qr) : null
  const ticket = where
    ? await db.tickets.findUnique({ where, select: { id: true, event_id: true, order_id: true, door_code: true, ticket_type: { select: { name: true } } } })
    : id
      ? await db.tickets.findUnique({ where: { id }, select: { id: true, event_id: true, order_id: true, door_code: true, ticket_type: { select: { name: true } } } })
      : null
  return ticket?.event_id === eventId ? ticket : null
}

/** Let a ticket in, or say in one word why not. */
export async function admitAtDoor(eventId: string, user: { id: string; role: user_role }, credential: DoorCredential): Promise<DoorAnswer> {
  if (!ticketingOn()) return { kind: "off" }
  if (!isUuid(eventId)) return { kind: "invalid", code: null }
  const typed = "code" in credential ? cleanCode(credential.code) : null
  // Who may operate the door, before any attempt counts: a stranger must not spend the event's ceiling.
  const event = await db.events.findFirst({ where: { id: eventId, deleted_at: null }, select: eventPermissionSelect })
  if (!event || !eventPermissions(await actorFor(user), event).canOperate) return { kind: "not_authorized" }

  const retryAfter = await overLimit(eventId, user.id)
  if (retryAfter !== null) return { kind: "wait", retryAfter }

  const redeem: RedeemCredential = "code" in credential ? { doorCode: typed ?? "" } : { qr: String(credential.qr ?? "") }
  const result = await redeemTicket({ eventId, user, credential: redeem })
  if (!result.ok && result.reason === "not_authorized") return { kind: "not_authorized" }
  if (!result.ok && result.reason === "ticketing_off") return { kind: "off" }
  if (!result.ok && result.reason === "invalid") return { kind: "invalid", code: typed }

  const ticket = await ticketOf(eventId, credential)
  if (!ticket) return { kind: "invalid", code: typed }
  if (!result.ok) return { kind: "used", code: ticket.door_code, typeName: ticket.ticket_type.name, at: result.redeemedAt ?? new Date() }

  const order = await db.tickets.findMany({ where: { order_id: ticket.order_id }, orderBy: { id: "asc" }, select: { id: true } })
  return {
    kind: "let_in",
    code: ticket.door_code,
    typeName: ticket.ticket_type.name,
    nth: order.findIndex((t) => t.id === ticket.id) + 1,
    of: order.length,
    at: result.redeemedAt,
  }
}

/** "1,905 of 2,274 in": tickets let in, of the valid ones (their orders paid). */
export async function doorCount(eventId: string): Promise<{ inside: number; of: number }> {
  const [inside, of] = await Promise.all([
    db.tickets.count({ where: { event_id: eventId, redeemed_at: { not: null }, order: { status: "paid" } } }),
    db.tickets.count({ where: { event_id: eventId, order: { status: "paid" } } }),
  ])
  return { inside, of }
}
