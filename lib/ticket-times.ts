import type { Prisma } from "@prisma/client"

/**
 * Whether an edit may move a ticketed event's times (SCRUM-1014, security
 * reviews 2, 6 and 7). Once it has paid or held ticket orders: fixed after it
 * has started (`times_locked`), and before that it may only move **later** (a
 * postponement), never earlier and never into the past (`times_only_later`).
 * Its buyers paid for that night; each payout's own `release_floor` already
 * refuses an early release, and the edit does not offer the move at all.
 *
 * Asked inside the edit's transaction (`updateEventTracked`), after the event
 * row is locked `FOR UPDATE`, with the orders counted in that transaction:
 * `reserveTickets` takes the same row `FOR SHARE` before it holds seats, so an
 * edit and a reserve never interleave. Null when the edit is allowed.
 */
export type TimesRefusal = { code: "times_locked" | "times_only_later"; sentence: string }

export async function ticketTimesRefusal(
  tx: Prisma.TransactionClient,
  before: { id: string; start_time: Date; end_time: Date },
  next: { start_time: Date; end_time: Date },
  now: Date = new Date()
): Promise<TimesRefusal | null> {
  const moves = next.start_time.getTime() !== before.start_time.getTime() || next.end_time.getTime() !== before.end_time.getTime()
  if (!moves) return null
  // Paid, or held and about to be: a buyer mid-checkout pays for the night they were shown.
  if ((await tx.ticket_orders.count({ where: { event_id: before.id, status: { in: ["paid", "pending"] } }, take: 1 })) === 0) return null
  if (before.start_time <= now) return { code: "times_locked", sentence: "This event has started and has sold tickets, so its start and end can’t change." }
  if (next.start_time < before.start_time || next.end_time < before.end_time || next.start_time <= now) {
    return { code: "times_only_later", sentence: "This event has sold tickets, so it can only move later: not earlier, and not into the past." }
  }
  return null
}
