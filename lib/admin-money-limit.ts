import { requireAdmin } from "@/lib/current-user"
import { hit } from "@/lib/rate-limit-store"
import { Refusal } from "@/lib/refusal"

/**
 * An admin's money actions — grants, ends, revokes, charges, payment links —
 * share one ceiling per admin. Kept out of the `"use server"` action files so
 * it is a helper, not a callable endpoint.
 */
const ADMIN_ACTIONS = { max: 30, windowMs: 60_000 }

/** `requireAdmin`, then the admin's own limit on money changes. */
export async function requireAdminWithinLimit() {
  const user = await requireAdmin()
  // Counted before the action runs, refusals included: a script holding an
  // admin session cannot loop them.
  const { count } = await hit(`billing:admin:${user.id}`, ADMIN_ACTIONS.windowMs)
  if (count > ADMIN_ACTIONS.max) throw new Refusal("Too many changes in a minute. Wait a moment and try again.")
  return user
}
