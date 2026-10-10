import "server-only"

import { auditInTx } from "./audit-log"
import { createHash, timingSafeEqual } from "crypto"

import { Prisma } from "@prisma/client"
import { z } from "zod"

import { db } from "./db"
import {
  applyStoreWindow,
  nightPassEnd,
  storeRow,
  transferStoreEntitlements,
  type PlusProduct,
  type StoreSource,
} from "./entitlements"
import { revenuecatSecretKey, storeEnvironment } from "./env"
import { logger } from "./logger"
import { PLUS } from "./plus"
import { subscriberTransactionIds } from "./revenuecat-api"

/**
 * What a verified RevenueCat delivery does (plan v2 §5, §9.3).
 *
 * The route has already checked the `Authorization` header. Here, in ONE
 * transaction:
 *
 *   1. **Claimed** on RevenueCat's event id (its retries reuse it) and on the
 *      body's hash: a replay, or a twin racing this one, inserts nothing.
 *   2. **Locked** per person: an advisory lock on every app user id the event
 *      names (both sides of a TRANSFER), taken in sorted order, so two
 *      deliveries about one person apply one after the other.
 *   3. **The person is `app_user_id`** — our user id, which the app passes to
 *      `Purchases.logIn` at sign-in. Never a subscriber attribute (anyone with
 *      the app can set those). An id that is not one of our people (an
 *      anonymous `$RCAnonymousID`, a deleted account) is recorded, never granted.
 *   4. **Ordered by the store's clock** (`event_timestamp_ms`): each event
 *      carries the subscription's whole state at that moment, so the newest
 *      one wins and an older one arriving late changes nothing
 *      (`applyStoreWindow`).
 *   5. **Held to this environment**: sandbox purchases grant only outside
 *      production, real ones only in production (`storeEnvironment`).
 *   6. **Marked**, and a failure anywhere rolls the claim back, so RevenueCat's
 *      retry finds the delivery new again.
 *
 * What each event does to the purchase's window (one row per subscription —
 * the store's `original_transaction_id` — or per Night Pass):
 *
 *   INITIAL_PURCHASE, RENEWAL, UNCANCELLATION,
 *   SUBSCRIPTION_EXTENDED, REFUND_REVERSED   until `expiration_at_ms`
 *   CANCELLATION                             until `expiration_at_ms`: access to the period's end
 *   CANCELLATION, cancel_reason CUSTOMER_SUPPORT or DEVELOPER_INITIATED
 *                                            a refund: ends now (the event's time) —
 *                                            if it refunds the current window's
 *                                            transaction; an older period's refund
 *                                            ends nothing and is audited
 *   EXPIRATION                               until `expiration_at_ms`, never past the event
 *   BILLING_ISSUE                            until the grace period's end, else `expiration_at_ms`
 *   NON_RENEWING_PURCHASE (the Night Pass)   24 h from purchase, or from the end of the last
 *                                            one not yet over; one row per transaction
 *   TRANSFER                                 only what RevenueCat's own record of the
 *                                            receiving account confirms moves (below)
 *   PRODUCT_CHANGE                           nothing: informational; the change arrives as a
 *                                            RENEWAL (Apple) or INITIAL_PURCHASE (Google)
 *   SUBSCRIBER_ALIAS                         nothing: deprecated, and the app logs in before
 *                                            any purchase, so a purchase never lands on an alias
 *   anything else (TEST, SUBSCRIPTION_PAUSED, …)   recorded only
 *
 * The entitlement is written here and nowhere else on the store path. The app
 * saying "purchased" writes nothing; it waits for this (`GET /me/plus`).
 */

const PROVIDER = "revenuecat"

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest()

/**
 * Is this the `Authorization` header we configured on the webhook
 * (`Bearer <secret>`)? Constant time over SHA-256 digests, so neither the
 * secret's length nor a matching prefix shows in the timing (MN-U03).
 */
export function authorised(header: string | null, secret: string): boolean {
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${secret}`))
}

/** Why a delivery changed nothing. Stored in `payment_events.error`. */
export type Refused =
  | "unknown_user"
  | "wrong_environment"
  | "unsupported_store"
  | "not_ours"
  | "malformed"
  | "stale"
  | "old_period_refund"
  | "unreconciled"

export interface DeliveryResult {
  duplicate: boolean
  applied: boolean
  refused?: Refused
}

/** Milliseconds since 1970, within what a Date can hold (8.64e15): never an Invalid Date. */
const ms = z.number().int().nonnegative().max(8.64e15)
const appUserId = z.string().min(1).max(200)
const text = (max: number) => z.string().max(max).nullish()

/**
 * The fields a delivery is read for — and, because zod drops every key it
 * does not name, also exactly what is stored: ids, products, times, states.
 * Never `subscriber_attributes` (email, device ids), `aliases`, the country
 * or experiments.
 */
export const revenuecatBodySchema = z.object({
  api_version: text(16),
  event: z.object({
    id: z.string().min(1).max(100),
    type: z.string().min(1).max(64),
    event_timestamp_ms: ms,
    app_user_id: appUserId.nullish(),
    product_id: text(200),
    new_product_id: text(200),
    entitlement_ids: z.array(z.string().max(100)).max(50).nullish(),
    period_type: text(32),
    purchased_at_ms: ms.nullish(),
    expiration_at_ms: ms.nullish(),
    grace_period_expiration_at_ms: ms.nullish(),
    environment: text(32),
    store: text(32),
    transaction_id: text(200),
    original_transaction_id: text(200),
    cancel_reason: text(64),
    expiration_reason: text(64),
    is_family_share: z.boolean().nullish(),
    price: z.number().nullish(),
    currency: text(8),
    transferred_from: z.array(appUserId).max(50).nullish(),
    transferred_to: z.array(appUserId).max(50).nullish(),
  }),
})
export type RevenuecatEvent = z.infer<typeof revenuecatBodySchema>["event"]

/** The stores Blendn+ is sold in. Anything else RevenueCat can carry (Stripe, promotional grants…) is not ours. */
const SOURCE: Record<string, StoreSource> = { APP_STORE: "apple", PLAY_STORE: "google" }

const WINDOW_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "CANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "SUBSCRIPTION_EXTENDED",
  "REFUND_REVERSED",
  "NON_RENEWING_PURCHASE",
])

type Tx = Prisma.TransactionClient
interface Outcome {
  applied: boolean
  refused?: Refused
}
const applied: Outcome = { applied: true }
const nothing: Outcome = { applied: false }
const refuse = (refused: Refused): Outcome => ({ applied: false, refused })

/**
 * An authorised body this server could not read (not JSON, or not the shape
 * above). Kept — by its hash, with RevenueCat's type when there is one — and
 * answered 200: a 4xx would be retried five times and then dropped, and a
 * money event dropped silently is worse than one an operator can find.
 */
export async function recordUnreadable(bodySha256: string, json: unknown, now: Date = new Date()): Promise<void> {
  const typed = z.object({ event: z.object({ type: z.string() }) }).safeParse(json)
  const type = typed.success ? typed.data.event.type.slice(0, 64) : "unreadable"
  await db.payment_events.createMany({
    data: [
      {
        provider: PROVIDER,
        provider_event_id: `unreadable:${bodySha256}`,
        body_sha256: bodySha256,
        type: type,
        payload: { unreadable: true },
        received_at: now,
        error: "malformed",
      },
    ],
    skipDuplicates: true,
  })
  logger.error("RevenueCat delivery could not be read; kept by its hash", { bodySha256, type })
}

/** Record one verified delivery and apply it. Idempotent on the event id and on the body. */
export async function recordRevenuecatEvent(
  body: z.infer<typeof revenuecatBodySchema>,
  bodySha256: string,
  now: Date = new Date()
): Promise<DeliveryResult> {
  const e = body.event
  // Read before the transaction, never inside it: a network call must not hold the person's lock.
  const confirmed = e.type === "TRANSFER" ? await confirmedForReceiver(e) : undefined
  const result = await db.$transaction(
    async (tx) => {
      const { count } = await tx.payment_events.createMany({
        data: [
          {
            provider: PROVIDER,
            provider_event_id: e.id,
            body_sha256: bodySha256,
            type: e.type,
            payload: body as Prisma.InputJsonValue,
            received_at: now,
          },
        ],
        skipDuplicates: true,
      })
      if (count === 0) return { duplicate: true, outcome: nothing }

      await lockPeople(tx, [e.app_user_id, ...(e.transferred_from ?? []), ...(e.transferred_to ?? [])])
      const outcome = await apply(tx, e, now, confirmed)
      await tx.payment_events.update({
        where: { provider_provider_event_id: { provider: PROVIDER, provider_event_id: e.id } },
        data: outcome.refused ? { error: outcome.refused } : { processed_at: new Date() },
      })
      return { duplicate: false, outcome }
    },
    { maxWait: 5_000, timeout: 15_000 }
  )

  const { outcome } = result
  if (outcome.refused) {
    // Money the store took and we did not grant is the operator's to look at.
    const level =
      outcome.refused === "stale" ? "info" : outcome.refused === "wrong_environment" || outcome.refused === "old_period_refund" ? "warn" : "error"
    logger[level]("RevenueCat delivery not applied", {
      eventId: e.id,
      type: e.type,
      refused: outcome.refused,
      environment: e.environment ?? null,
      ref: e.original_transaction_id ?? e.transaction_id ?? null,
    })
  }
  return { duplicate: result.duplicate, applied: outcome.applied, ...(outcome.refused ? { refused: outcome.refused } : {}) }
}

/** One person at a time, every person the event names, always in the same order (no deadlock). */
async function lockPeople(tx: Tx, ids: Array<string | null | undefined>) {
  const people = [...new Set(ids.filter((id): id is string => Boolean(id)))].sort()
  for (const id of people) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`revenuecat:${id}`}, 0))`
  }
}

/**
 * Our person, if this app user id is one: an account that exists and was not
 * deleted — held FOR SHARE until the transaction ends, so an erasure cannot
 * slip in between this read and the grant. (The erasure also takes this
 * person's `revenuecat:` lock first; either way one waits for the other.)
 */
async function personOf(tx: Tx, appUserId: string | null | undefined): Promise<string | null> {
  if (!appUserId) return null
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User" WHERE id = ${appUserId} AND "deletedAt" IS NULL FOR SHARE`
  return rows[0]?.id ?? null
}

/** The one account a TRANSFER names as receiving it, or null (none, or several). */
const receiverOf = (e: RevenuecatEvent): string | null => (e.transferred_to?.length === 1 ? e.transferred_to[0] : null)

/**
 * For a TRANSFER: every store transaction RevenueCat now holds under the
 * receiving account, read from RevenueCat itself with the secret key. Null
 * when the key is not set — then nothing moves (fail closed). A failed read
 * throws: the delivery is a 500 and RevenueCat retries it.
 */
async function confirmedForReceiver(e: RevenuecatEvent): Promise<Set<string> | null> {
  const key = revenuecatSecretKey()
  const to = receiverOf(e)
  if (!key || !to) return null
  return subscriberTransactionIds(to, key, storeEnvironment() === "SANDBOX")
}

/** Which Blendn+ product a purchase is: the Night Pass by product id, Plus by RevenueCat's `plus` entitlement. */
function productOf(e: RevenuecatEvent): PlusProduct | null {
  if (e.product_id && (PLUS.STORE.NIGHT_PASS_PRODUCTS as readonly string[]).includes(e.product_id)) return "night_pass"
  if (e.entitlement_ids?.includes(PLUS.STORE.ENTITLEMENT)) return "plus"
  return null
}

async function apply(tx: Tx, e: RevenuecatEvent, now: Date, confirmed: Set<string> | null | undefined): Promise<Outcome> {
  const isWindow = WINDOW_EVENTS.has(e.type)
  if (!isWindow && e.type !== "TRANSFER") return nothing
  // A TRANSFER may leave its environment out; a purchase never does.
  if ((isWindow || e.environment) && e.environment !== storeEnvironment()) return refuse("wrong_environment")
  return isWindow ? applyPurchase(tx, e, now) : applyTransfer(tx, e, confirmed ?? null)
}

/** RevenueCat's refunds: a support refund, or one the developer made (Google revocations). */
const REFUND_REASONS = new Set(["CUSTOMER_SUPPORT", "DEVELOPER_INITIATED"])

async function applyPurchase(tx: Tx, e: RevenuecatEvent, now: Date): Promise<Outcome> {
  const source = e.store ? SOURCE[e.store] : undefined
  if (!source) return refuse("unsupported_store")
  // A Night Pass is one purchase per transaction; a subscription is one row for its whole life.
  const guess = productOf(e)
  const ref = guess === "night_pass" ? (e.transaction_id ?? e.original_transaction_id) : (e.original_transaction_id ?? e.transaction_id)
  if (!ref) return refuse("malformed")

  const eventAt = new Date(e.event_timestamp_ms)
  const userId = await personOf(tx, e.app_user_id)
  const existing = await storeRow(tx, source, ref)
  const product = existing?.product ?? guess
  if (!product) return refuse("not_ours")
  if (!existing && !userId) return refuse("unknown_user")

  const refund = e.type === "CANCELLATION" && REFUND_REASONS.has(e.cancel_reason ?? "")
  // A refund of an older period of a subscription that has since renewed ends
  // nothing: the period it refunds is over, and the one running was paid for.
  if (refund && product === "plus" && existing?.windowTransactionId && e.transaction_id && e.transaction_id !== existing.windowTransactionId) {
    await auditInTx(tx, {
        action: "entitlement.refund_old_period",
        resource: "user",
        resourceId: existing.subjectId,
        details: { ref: ref, refunded: e.transaction_id, current: existing.windowTransactionId, eventId: e.id },
      })
    return refuse("old_period_refund")
  }

  const bought = new Date(Math.min(e.purchased_at_ms ?? e.event_timestamp_ms, now.getTime()))
  let startsAt: Date
  let expiresAt: Date
  if (product === "night_pass") {
    // Stacks after the last pass not yet over (D-16); a refund ends it at the
    // refund, never later than it would have ended anyway.
    const running = existing ? null : await nightPassEnd(tx, userId!, ref, now)
    startsAt = existing?.startsAt ?? (running && running > bought ? running : bought)
    const natural = startsAt.getTime() + PLUS.NIGHT_PASS_MS
    expiresAt = new Date(refund ? Math.min(natural, e.event_timestamp_ms) : natural)
  } else {
    const until = e.type === "BILLING_ISSUE" ? (e.grace_period_expiration_at_ms ?? e.expiration_at_ms) : e.expiration_at_ms
    if (until === null || until === undefined) return refuse("malformed")
    startsAt = existing?.startsAt ?? bought
    // A refund ends it now; an expiration has ended it — neither ever lengthens it.
    expiresAt = new Date(refund || e.type === "EXPIRATION" ? Math.min(until, e.event_timestamp_ms) : until)
  }

  const done = await applyStoreWindow(tx, {
    userId,
    product,
    source,
    externalRef: ref,
    startsAt,
    expiresAt,
    eventAt,
    transactionId: e.transaction_id ?? null,
  })
  return done === "stale" ? refuse("stale") : done === "no_owner" ? refuse("unknown_user") : applied
}

/**
 * A TRANSFER is RevenueCat saying purchases moved between app user ids —
 * when somebody restores while signed in as another account. App user ids
 * are set by the app (`Purchases.logIn`), so the event alone cannot say WHICH
 * purchases are the restorer's: an account signed in under somebody else's
 * id and restored would take everything that person bought (review H1).
 *
 * So the event decides only who: exactly one receiving account, ours and not
 * deleted, and giving accounts ours and not deleted. What moves is decided by
 * RevenueCat's own record of the receiving account, read with the secret key
 * (`confirmedForReceiver`): only purchases RevenueCat now holds under it.
 * Without the key nothing moves (`unreconciled`, for the runbook). Only rows
 * that exist move, so it never creates access nobody paid for, and every move
 * is audited in this transaction.
 */
async function applyTransfer(tx: Tx, e: RevenuecatEvent, confirmed: Set<string> | null): Promise<Outcome> {
  if (e.store && !SOURCE[e.store]) return nothing
  const receiver = receiverOf(e)
  const to = receiver ? await personOf(tx, receiver) : null
  if (!to) return refuse("unknown_user")
  const named = [...new Set((e.transferred_from ?? []).filter((id) => id !== to))]
  const from = (await tx.user.findMany({ where: { id: { in: named }, deletedAt: null }, select: { id: true } })).map((u) => u.id)
  if (from.length === 0) return refuse("unknown_user")
  if (confirmed === null) return refuse("unreconciled")
  const moved = await transferStoreEntitlements(tx, {
    from,
    to,
    sources: e.store ? [SOURCE[e.store]] : ["apple", "google"],
    at: new Date(e.event_timestamp_ms),
    confirmed: [...confirmed],
  })
  if (moved === 0) return nothing
  await auditInTx(tx, {
      action: "entitlement.transferred",
      resource: "user",
      resourceId: to,
      details: { from: from, moved: moved, store: e.store ?? null, eventId: e.id, reconciled: true },
    })
  return applied
}
