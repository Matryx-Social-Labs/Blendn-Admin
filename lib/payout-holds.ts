import type { Prisma } from "@prisma/client"

import { db } from "./db"
import { logger } from "./logger"
import { modifyTransferHold, transferHold } from "./razorpay"

/**
 * An event's payout holds (SCRUM-1014, security reviews 3 and 4). The hold is
 * what makes refunds and chargebacks safe (organizer terms 4.1, 4.3), so it is
 * never released before the event has happened:
 *
 * - **One floor.** `holdFloor` (lib/ticket-payments.ts): the later of start
 *   and end, + 3 days. A new payout, its transfer and a postponement are all
 *   held to it.
 * - **One lock per event.** Everything that sets a hold for an event's payouts
 *   (a postponement, a transfer being made) runs under `withPayoutLock`, a
 *   Postgres advisory lock on `payout:<event id>` held across the Razorpay
 *   calls, and re-reads the event's times and the payout rows inside it. Two
 *   postponements, or a postponement and a transfer, cannot interleave.
 * - **Only upward.** A hold is raised, never lowered: in the database by an
 *   `on_hold_until < new` filter, at Razorpay by asking for the transfer's
 *   current hold first and skipping when it is already as late.
 * - **Razorpay first.** A postponement raises every transferred hold at
 *   Razorpay before the event's new times are written; if Razorpay refuses
 *   one, the edit is refused. The database rows are raised in the edit's own
 *   transaction.
 */

/**
 * Long enough for a postponement's Razorpay calls; the lock is released on commit, rollback, or a dropped connection.
 * ponytail: a big event's postponement is two Razorpay calls per transferred order, RAZORPAY_PARALLEL at a time, inside
 * the request: ~2,000 orders is about a minute. Move it to a job with a "holds pending" state if events get that big.
 */
const LOCK_TX = { maxWait: 15_000, timeout: 5 * 60_000 }
const RAZORPAY_PARALLEL = 8

/**
 * Run `fn` holding the event's payout lock. The lock lives in its own
 * transaction, whose connection holds it until `fn` settles; `fn`'s reads and
 * writes go through their own connections and commit inside the lock. Its
 * Razorpay calls are outside any transaction that holds a row lock.
 */
export function withPayoutLock<T>(eventId: string, fn: () => Promise<T>): Promise<T> {
  return db.$transaction(async (lock) => {
    await lock.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout:${eventId}`}))`
    return fn()
  }, LOCK_TX)
}

/** The event's payouts still held whose recorded hold is earlier than `until`. Released ones are gone: nothing to hold. */
const unreleasedBelow = (eventId: string, until: Date, now: Date) => ({
  order: { event_id: eventId },
  status: { in: ["pending" as const, "on_hold" as const] },
  on_hold_until: { gt: now, lt: until },
})

/**
 * Raise one transfer's hold at Razorpay to `until`, unless Razorpay already
 * holds it at least that long. Throws when Razorpay refuses or cannot be read.
 */
export async function raiseTransferHold(transferId: string, until: Date): Promise<void> {
  const current = await transferHold(transferId)
  if (current !== null && current.getTime() >= until.getTime()) return
  await modifyTransferHold(transferId, until)
}

/**
 * At Razorpay, raise every transferred, unreleased payout of the event below
 * `until`, pending or on hold. Call under `withPayoutLock`. False when
 * Razorpay could not do one: the caller refuses the edit. Transfers already
 * raised before a failure stay raised, which only holds money longer.
 */
export async function raiseTransferHolds(eventId: string, until: Date, now: Date = new Date()): Promise<boolean> {
  const payouts = await db.ticket_payouts.findMany({
    where: { ...unreleasedBelow(eventId, until, now), provider_transfer_ref: { not: null } },
    select: { order_id: true, provider_transfer_ref: true },
  })
  let failed = false
  const queue = [...payouts]
  const worker = async () => {
    for (let p = queue.shift(); p && !failed; p = queue.shift()) {
      try {
        await raiseTransferHold(p.provider_transfer_ref!, until)
      } catch (error) {
        failed = true
        logger.error("Could not extend a payout's hold at Razorpay; the event's new time was refused", {
          eventId,
          orderId: p.order_id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(RAZORPAY_PARALLEL, payouts.length) }, worker))
  return !failed
}

/** The same raise in the database, only upward, inside the transaction that moves the event's times. */
export async function raiseHoldsInTx(tx: Prisma.TransactionClient, eventId: string, until: Date, now: Date = new Date()): Promise<number> {
  const { count } = await tx.ticket_payouts.updateMany({ where: unreleasedBelow(eventId, until, now), data: { on_hold_until: until } })
  return count
}
