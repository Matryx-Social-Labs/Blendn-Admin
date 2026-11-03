import type { Prisma } from "@prisma/client"

import { db } from "./db"
import { logger } from "./logger"
import { modifyTransferHold } from "./razorpay"
import { PAYOUT_HOLD_AFTER_EVENT_MS } from "./ticket-payments"

/**
 * A postponed ticketed event keeps its organizer's money held until after the
 * real night (SCRUM-1014, security review 3). The hold is what makes refunds
 * and chargebacks safe (organizer terms 4.1, 4.3): released three days after
 * the old end, it would leave nothing held for a night that has not happened.
 *
 * When an edit moves an event's end later, every payout not yet released has
 * its hold raised to the new end + 3 days: at Razorpay first, transfer by
 * transfer (`extendTransferHolds`, before the edit, never inside a
 * transaction), then in the database in the edit's own transaction
 * (`extendHoldsInTx`). If Razorpay cannot extend one, the edit is refused. A
 * hold is only ever raised, never shortened: moving an event earlier leaves
 * every hold where it was.
 */

/** When a payout for an event ending at `end` may be released. */
export const holdUntilFor = (end: Date) => new Date(end.getTime() + PAYOUT_HOLD_AFTER_EVENT_MS)

/** Payouts of the event still held, whose hold is earlier than `until`. Released ones are gone: nothing to extend. */
const extendable = (eventId: string, until: Date, now: Date) => ({ order: { event_id: eventId }, on_hold_until: { gt: now, lt: until } })

/**
 * Raise the hold of every transferred, unreleased payout of the event at
 * Razorpay to `newEnd` + 3 days. False when Razorpay refused or could not be
 * reached for any of them: the caller refuses the edit. Transfers already
 * extended before a failure stay extended, which only holds money longer.
 */
export async function extendTransferHolds(eventId: string, newEnd: Date, now: Date = new Date()): Promise<boolean> {
  const until = holdUntilFor(newEnd)
  const payouts = await db.ticket_payouts.findMany({
    where: { ...extendable(eventId, until, now), status: "on_hold", provider_transfer_ref: { not: null } },
    select: { order_id: true, provider_transfer_ref: true },
  })
  for (const p of payouts) {
    try {
      await modifyTransferHold(p.provider_transfer_ref!, until)
    } catch (error) {
      logger.error("Could not extend a payout's hold at Razorpay; the event's new time was refused", {
        eventId,
        orderId: p.order_id,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }
  return true
}

/** The same raise in the database, inside the transaction that moves the event's end. Pending payouts too: their transfer will carry it. */
export async function extendHoldsInTx(tx: Prisma.TransactionClient, eventId: string, newEnd: Date, now: Date = new Date()): Promise<number> {
  const until = holdUntilFor(newEnd)
  const { count } = await tx.ticket_payouts.updateMany({
    where: { ...extendable(eventId, until, now), status: { in: ["pending", "on_hold"] } },
    data: { on_hold_until: until },
  })
  return count
}
