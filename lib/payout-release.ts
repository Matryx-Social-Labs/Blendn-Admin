// Relative imports: reached from server.ts through lib/background.ts (`build:server`, plain tsc).
import { db } from "./db"
import { razorpayKeys, ticketingOn } from "./env"
import { logger } from "./logger"
import { releaseTransfer } from "./razorpay"
import { PAYOUT_HOLD_AFTER_EVENT_MS } from "./ticket-payments"

/**
 * Releasing organizers' payouts (SCRUM-1014, security review 5). We are the
 * only releaser: every Route transfer is created held at Razorpay with no end
 * (`createTransfer`: `on_hold`, no `on_hold_until`), so Razorpay never
 * releases on its own and nothing has to keep its clock in step with our
 * event times.
 *
 * Every few minutes, a payout is released once **both** its own
 * `release_floor` (the event's `holdFloor` when the order was paid, only ever
 * raised, trigger `ticket_payouts_release_floor_only_up`) and its event's
 * current `holdFloor` (the later of start and end, + 3 days) have passed, its
 * order is paid with no refund claimed, and its event was not cancelled. So a
 * postponement delays it with no Razorpay call, and moving an event earlier,
 * even into the past, never brings money forward (security review 6).
 *
 * Every field read, asked "can an organizer edit this to make money leave
 * earlier?": `release_floor` no (written at payment, only raised); event start
 * and end yes, but only ever as a further delay (GREATEST); event status no
 * (cancelled stops a release, it never starts one early); order status and
 * refund claim, payout status: system writers only.
 *
 * Per payout: one short statement claims it (`FOR UPDATE OF p, o SKIP
 * LOCKED`: the payout row, then its order, the one lock order every refund
 * path takes too; `on_hold` → `releasing`), re-checking the order and event
 * under the lock; then Razorpay is told `on_hold: false`; then the
 * row is marked `released`. Idempotent: a crash after Razorpay and before our
 * write leaves `releasing`, retried after `RELEASING_RETRY_MS`, and Razorpay's
 * "already released" counts as success (`releaseTransfer`). An organizer
 * refund (`refundOrder`) locks the same row and is refused once it is
 * `releasing` or `released`, so a refund and a release never both win.
 */

export const PAYOUT_RELEASE_MS = 5 * 60_000
/** A claim older than this is presumed crashed and retried. */
export const RELEASING_RETRY_MS = 30 * 60_000
const BATCH = 50
/** `holdFloor` in SQL: the later of start and end, + PAYOUT_HOLD_AFTER_EVENT_MS. */
const HOLD_SECONDS = PAYOUT_HOLD_AFTER_EVENT_MS / 1000

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Due now: held and past the event's current floor, or a claim stuck past the retry window. */
async function due(now: Date): Promise<string[]> {
  const rows = await db.$queryRaw<{ order_id: string }[]>`
    SELECT p.order_id::text
      FROM ticket_payouts p
      JOIN ticket_orders o ON o.id = p.order_id
      JOIN events e ON e.id = o.event_id
     WHERE p.status IN ('on_hold', 'releasing') AND p.provider_transfer_ref IS NOT NULL
       AND (
         (p.status = 'on_hold' AND o.status = 'paid' AND o.refund_requested_at IS NULL
           AND e.kind = 'event' AND e.status <> 'cancelled'
           AND GREATEST(p.release_floor, GREATEST(e.start_time, e.end_time) + ${HOLD_SECONDS} * interval '1 second') <= ${now})
         OR (p.status = 'releasing' AND p.releasing_at < now() - ${`${RELEASING_RETRY_MS / 1000} seconds`}::interval)
       )
     ORDER BY p.created_at
     LIMIT ${BATCH}`
  return rows.map((r) => r.order_id)
}

/** Claim one payout, re-checking every condition under its row lock. Null when another worker, a refund, or a move got there first. */
async function claim(orderId: string, now: Date): Promise<string | null> {
  const [row] = await db.$queryRaw<{ provider_transfer_ref: string }[]>`
    UPDATE ticket_payouts SET status = 'releasing', releasing_at = now(), updated_at = now()
     WHERE order_id = (
       SELECT p.order_id
         FROM ticket_payouts p
         JOIN ticket_orders o ON o.id = p.order_id
         JOIN events e ON e.id = o.event_id
        WHERE p.order_id = ${orderId}::uuid AND p.provider_transfer_ref IS NOT NULL
          AND (
            (p.status = 'on_hold' AND o.status = 'paid' AND o.refund_requested_at IS NULL
              AND e.kind = 'event' AND e.status <> 'cancelled'
           AND GREATEST(p.release_floor, GREATEST(e.start_time, e.end_time) + ${HOLD_SECONDS} * interval '1 second') <= ${now})
            OR (p.status = 'releasing' AND p.releasing_at < now() - ${`${RELEASING_RETRY_MS / 1000} seconds`}::interval)
          )
          FOR UPDATE OF p, o SKIP LOCKED)
    RETURNING provider_transfer_ref`
  return row?.provider_transfer_ref ?? null
}

/** One pass. `now` is the release clock (tests move it); claims age on the database's own clock. */
export async function releaseDuePayouts(now: Date = new Date()): Promise<{ released: number; failed: number }> {
  if (!razorpayKeys()) return { released: 0, failed: 0 }
  let released = 0
  let failed = 0
  for (const orderId of await due(now)) {
    const transfer = await claim(orderId, now)
    if (!transfer) continue
    try {
      await releaseTransfer(transfer)
      await db.ticket_payouts.updateMany({ where: { order_id: orderId, status: "releasing" }, data: { status: "released", released_at: new Date() } })
      released++
    } catch (error) {
      // Left `releasing`: refunds stay refused, and the claim is retried after RELEASING_RETRY_MS.
      failed++
      logger.error("Ticket payout release failed at Razorpay; retried later", { orderId, error: message(error) })
    }
  }
  return { released, failed }
}

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function run(): Promise<void> {
  try {
    const done = await releaseDuePayouts()
    if (done.released || done.failed) logger.info("Ticket payouts released", done)
  } catch (error) {
    logger.error("Ticket payout release pass failed", { error: message(error) })
  }
}

/** Self-scheduling, like the other sweepers. Off (no timer) unless TICKETING is on at boot. */
export function startPayoutReleaser(): void {
  if (timer || !ticketingOn()) return
  stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => void run().finally(schedule), PAYOUT_RELEASE_MS)
    timer.unref?.()
  }
  void run().finally(schedule)
}

export function stopPayoutReleaser(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}
