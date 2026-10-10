import { createHash } from "crypto"
import { NextResponse, type NextRequest } from "next/server"

import { clientNetworkFrom } from "@/lib/client-ip"
import { revenuecatWebhookSecret } from "@/lib/env"
import { logger } from "@/lib/logger"
import { hit } from "@/lib/rate-limit-store"
import { authorised, recordRevenuecatEvent, revenuecatBodySchema } from "@/lib/revenuecat-webhook"
import { readCapped } from "@/lib/webhook-body"

/**
 * POST /api/webhooks/revenuecat — the App Store's and Google Play's Blendn+
 * purchases, through RevenueCat (plan v2 §5). The only writer of a store-bought
 * entitlement.
 *
 * Outside `/api/mobile` and outside `middleware.ts`'s matcher on purpose: no
 * CORS, no session, no mobile JWT. Only POST is exported, so any other method
 * is a 405.
 *
 * In order, cheapest first, so a flood of forgeries costs a counter and a hash
 * and never a database query (test plan SEC-18):
 *
 *   1. the body, read through a capped stream;
 *   2. the `Authorization` header, which must be exactly
 *      `Bearer <REVENUECAT_WEBHOOK_SECRET>` — the value set on the webhook in
 *      the RevenueCat dashboard (docs/IAP-SETUP.md). Compared in constant time
 *      over SHA-256 digests, so neither the secret's length nor a matching
 *      prefix shows in the timing. A network that keeps failing it is
 *      rate-limited; a good delivery is never counted;
 *   3. only then JSON, its shape (zod), and `lib/revenuecat-webhook.ts`.
 *
 * Unset secret: the feature is off and everything is a 401.
 *
 * Every authorised delivery answers 200, including one that changed nothing
 * (an unknown person, the other environment, an older event): RevenueCat
 * retries a non-2xx five times over about two and a half hours, and retrying
 * a refusal changes nothing. A database failure answers 500, which it
 * retries; the transaction rolled the claim back, so the retry applies it.
 */

export const dynamic = "force-dynamic"

/** RevenueCat's events are a few KB. */
const MAX_BODY_BYTES = 64 * 1024
const BAD_AUTH = { max: 30, windowMs: 60_000 }

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

export async function POST(req: NextRequest) {
  const secret = revenuecatWebhookSecret()
  if (!secret) {
    logger.error("RevenueCat webhook rejected: REVENUECAT_WEBHOOK_SECRET is not set", {})
    return fail(401, "unauthorized")
  }

  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return fail(413, "too_large")
  const raw = await readCapped(req, MAX_BODY_BYTES)
  if (raw === null) return fail(413, "too_large")

  if (!authorised(req.headers.get("authorization"), secret)) {
    const { count, resetAt } = await hit(`rc-webhook-bad:${clientNetworkFrom(req.headers)}`, BAD_AUTH.windowMs)
    if (count > BAD_AUTH.max) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } })
    }
    return fail(401, "unauthorized")
  }

  let json: unknown
  try {
    json = JSON.parse(Buffer.from(raw).toString("utf8"))
  } catch {
    return fail(400, "malformed")
  }
  const body = revenuecatBodySchema.safeParse(json)
  if (!body.success) return fail(400, "malformed")

  const bodySha256 = createHash("sha256").update(raw).digest("hex")
  const result = await recordRevenuecatEvent(body.data, bodySha256)
  return NextResponse.json({ ok: true, ...result })
}
