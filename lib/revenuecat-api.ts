import "server-only"

import { z } from "zod"

/**
 * The server's own calls to RevenueCat (REST API v1, the secret key). Two:
 * what RevenueCat holds for an account — so a TRANSFER moves only what it
 * really moved — and deleting an erased account there.
 * https://www.revenuecat.com/docs/api-v1/customers
 */

const BASE = "https://api.revenuecat.com/v1"
const TIMEOUT_MS = 8_000

const purchase = z.object({ store_transaction_id: z.string().nullish(), is_sandbox: z.boolean().nullish() })
const subscriberSchema = z.object({
  subscriber: z.object({
    subscriptions: z.record(z.string(), purchase).nullish(),
    non_subscriptions: z.record(z.string(), z.array(purchase)).nullish(),
  }),
})

const url = (appUserId: string) => `${BASE}/subscribers/${encodeURIComponent(appUserId)}`

/**
 * Every store transaction RevenueCat now holds under this app user id, in this
 * store environment: a subscription's latest transaction, each one-off
 * purchase's. Throws when RevenueCat cannot be read, so the delivery asking is
 * a 500 and RevenueCat retries it.
 */
export async function subscriberTransactionIds(appUserId: string, key: string, sandbox: boolean): Promise<Set<string>> {
  const res = await fetch(url(appUserId), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`RevenueCat subscriber read failed: ${res.status}`)
  const { subscriber } = subscriberSchema.parse(await res.json())
  const all = [
    ...Object.values(subscriber.subscriptions ?? {}),
    ...Object.values(subscriber.non_subscriptions ?? {}).flat(),
  ]
  return new Set(
    all.filter((p) => Boolean(p.is_sandbox) === sandbox && p.store_transaction_id).map((p) => p.store_transaction_id as string)
  )
}

/** Delete the account at RevenueCat. 200 and 404 are both "gone" (RevenueCat's own advice); anything else throws. */
export async function deleteSubscriber(appUserId: string, key: string): Promise<void> {
  const res = await fetch(url(appUserId), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok && res.status !== 404) throw new Error(`RevenueCat delete failed: ${res.status}`)
}
