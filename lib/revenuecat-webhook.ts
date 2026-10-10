import "server-only"

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
import { storeEnvironment } from "./env"
import { logger } from "./logger"
import { PLUS } from "./plus"

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
 *   CANCELLATION, cancel_reason CUSTOMER_SUPPORT   a refund: ends now (the event's time)
 *   EXPIRATION                               until `expiration_at_ms`, already past
 *   BILLING_ISSUE                            until the grace period's end, else `expiration_at_ms`
 *   NON_RENEWING_PURCHASE (the Night Pass)   24 h from purchase, or from the end of one running
 *   TRANSFER                                 the rows move to the new owner
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
export type Refused = "unknown_user" | "wrong_environment" | "unsupported_store" | "not_ours" | "malformed" | "stale"

export interface DeliveryResult {
  duplicate: boolean
  applied: boolean
  refused?: Refused
}

const ms = z.number().int().nonnegative()
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

/** Record one verified delivery and apply it. Idempotent on the event id and on the body. */
export async function recordRevenuecatEvent(
  body: z.infer<typeof revenuecatBodySchema>,
  bodySha256: string,
  now: Date = new Date()
): Promise<DeliveryResult> {
  const e = body.event
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
      const outcome = await apply(tx, e, now)
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
    const level = outcome.refused === "stale" ? "info" : outcome.refused === "wrong_environment" ? "warn" : "error"
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

/** Our person, if this app user id is one: an account that exists and was not deleted. */
async function personOf(tx: Tx, appUserId: string | null | undefined): Promise<string | null> {
  if (!appUserId) return null
  const row = await tx.user.findFirst({ where: { id: appUserId, deletedAt: null }, select: { id: true } })
  return row?.id ?? null
}

/** Which Blendn+ product a purchase is: the Night Pass by product id, Plus by RevenueCat's `plus` entitlement. */
function productOf(e: RevenuecatEvent): PlusProduct | null {
  if (e.product_id && (PLUS.STORE.NIGHT_PASS_PRODUCTS as readonly string[]).includes(e.product_id)) return "night_pass"
  if (e.entitlement_ids?.includes(PLUS.STORE.ENTITLEMENT)) return "plus"
  return null
}

async function apply(tx: Tx, e: RevenuecatEvent, now: Date): Promise<Outcome> {
  const isWindow = WINDOW_EVENTS.has(e.type)
  if (!isWindow && e.type !== "TRANSFER") return nothing
  // A TRANSFER may leave its environment out; a purchase never does.
  if ((isWindow || e.environment) && e.environment !== storeEnvironment()) return refuse("wrong_environment")
  return isWindow ? applyPurchase(tx, e, now) : applyTransfer(tx, e)
}

async function applyPurchase(tx: Tx, e: RevenuecatEvent, now: Date): Promise<Outcome> {
  const source = e.store ? SOURCE[e.store] : undefined
  if (!source) return refuse("unsupported_store")
  const ref = e.original_transaction_id ?? e.transaction_id
  if (!ref) return refuse("malformed")

  const eventAt = new Date(e.event_timestamp_ms)
  const userId = await personOf(tx, e.app_user_id)
  const existing = await storeRow(tx, source, ref)
  const product = existing?.product ?? productOf(e)
  if (!product) return refuse("not_ours")
  if (!existing && !userId) return refuse("unknown_user")

  const refund = e.type === "CANCELLATION" && e.cancel_reason === "CUSTOMER_SUPPORT"
  const bought = new Date(Math.min(e.purchased_at_ms ?? e.event_timestamp_ms, now.getTime()))
  let startsAt: Date
  let expiresAt: Date
  if (product === "night_pass") {
    // Stacks after a pass still running (D-16); a refund ends it at the refund.
    const running = existing ? null : await nightPassEnd(tx, userId!, ref, now)
    startsAt = existing?.startsAt ?? (running && running > bought ? running : bought)
    expiresAt = refund ? eventAt : new Date(startsAt.getTime() + PLUS.NIGHT_PASS_MS)
  } else {
    const until = e.type === "BILLING_ISSUE" ? (e.grace_period_expiration_at_ms ?? e.expiration_at_ms) : e.expiration_at_ms
    if (until === null || until === undefined) return refuse("malformed")
    startsAt = existing?.startsAt ?? bought
    expiresAt = new Date(refund ? Math.min(until, e.event_timestamp_ms) : until)
  }

  const done = await applyStoreWindow(tx, { userId, product, source, externalRef: ref, startsAt, expiresAt, eventAt })
  return done === "stale" ? refuse("stale") : done === "no_owner" ? refuse("unknown_user") : applied
}

/**
 * A TRANSFER moves what was bought from the accounts it names to the ONE
 * account it names — both ours, from the verified event, never a guess:
 * a receiving list that is not exactly one of our people (anonymous, deleted,
 * unknown, or several) moves nothing and is recorded for the operator. Only
 * rows that exist move, so it never creates access nobody paid for. Every
 * move is audited in this transaction.
 *
 * RevenueCat sends one when somebody restores purchases while signed in as a
 * different account ("Transfer to new App User ID", the project's restore
 * behaviour): the Apple ID or Google account that paid decides who holds it,
 * as the stores intend (docs/IAP-SETUP.md).
 */
async function applyTransfer(tx: Tx, e: RevenuecatEvent): Promise<Outcome> {
  if (e.store && !SOURCE[e.store]) return nothing
  const receiving = e.transferred_to ?? []
  const to = receiving.length === 1 ? await personOf(tx, receiving[0]) : null
  if (!to) return refuse("unknown_user")
  const named = [...new Set((e.transferred_from ?? []).filter((id) => id !== to))]
  const from = (await tx.user.findMany({ where: { id: { in: named } }, select: { id: true } })).map((u) => u.id)
  if (from.length === 0) return refuse("unknown_user")
  const moved = await transferStoreEntitlements(tx, {
    from,
    to,
    sources: e.store ? [SOURCE[e.store]] : ["apple", "google"],
    at: new Date(e.event_timestamp_ms),
  })
  if (moved === 0) return nothing
  await tx.audit_logs.create({
    data: {
      action: "entitlement.transferred",
      resource: "user",
      resource_id: to,
      details: { from: from, moved: moved, store: e.store ?? null, eventId: e.id },
    },
  })
  return applied
}
