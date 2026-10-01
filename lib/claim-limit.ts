import { headers } from "next/headers"

import { clientIpFrom } from "@/lib/client-ip"
import { CLAIM_LIMITS } from "@/lib/curation"
import { hit } from "@/lib/rate-limit-store"

const HOUR_MS = 60 * 60 * 1000

/** What a claim is on. The key is `rl:claim:<kind>:<id>`, so an event's stays what it was. */
export interface ClaimTarget {
  kind: "event" | "venue"
  id: string
}

/**
 * Three windows, checked together, Redis-backed — for the two public claim
 * forms, `/claim/[eventId]` and `/claim/venue/[venueId]`.
 *
 * `lib/rate-limit.ts` wraps this for route handlers and needs a `NextRequest`;
 * a server action has no request object, so it calls `hit()` directly rather
 * than growing a second limiter — the counter, the store and the Redis
 * fallback are all the same ones every rate-limited route already uses.
 *
 * The address and IP windows are shared by both kinds: one person flooding
 * event claims and venue claims is one flooder.
 *
 * Returns the message to refuse with, or null to proceed.
 */
export async function overClaimLimit(email: string, target: ClaimTarget): Promise<string | null> {
  /*
   * `x-forwarded-for` is spoofable, which is why it is the weakest of the three
   * and never the only one. The LAST hop is the one the platform's edge added
   * — the left-most is whatever the client sent, which is why this goes
   * through `clientIpFrom` like every other limiter. With no header at all
   * every anonymous caller shares one bucket, which fails toward refusing.
   */
  const ip = clientIpFrom(await headers())

  const [byEmail, byTarget, byIp] = await Promise.all([
    hit(`rl:claim:email:${email}`, HOUR_MS),
    hit(`rl:claim:${target.kind}:${target.id}`, HOUR_MS),
    hit(`rl:claim:ip:${ip}`, HOUR_MS),
  ])

  if (
    byEmail.count > CLAIM_LIMITS.perEmailPerHour ||
    byIp.count > CLAIM_LIMITS.perIpPerHour ||
    // Deliberately the same sentence for all three. Telling a flooder which
    // bucket they hit tells them which one to vary.
    byTarget.count > CLAIM_LIMITS.perTargetPerHour
  ) {
    return "You have filed several claims recently. Give us a little time to read them."
  }
  return null
}
