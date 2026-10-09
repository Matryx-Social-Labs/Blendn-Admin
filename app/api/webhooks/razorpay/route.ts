import { NextResponse, type NextRequest } from "next/server"

import { clientNetworkFrom } from "@/lib/client-ip"
import { logger } from "@/lib/logger"
import { hit } from "@/lib/rate-limit-store"
import { razorpayWebhookSecret, verifyWebhookSignature } from "@/lib/razorpay"
import { recordRazorpayDelivery } from "@/lib/razorpay-webhook"

/**
 * POST /api/webhooks/razorpay — Razorpay's deliveries (plan v2 §9.2).
 *
 * Outside `/api/mobile` and outside `middleware.ts`'s matcher on purpose: no
 * CORS, no session, and nothing between Razorpay's bytes and the signature
 * check. Only POST is exported, so any other method is a 405.
 *
 * In order, cheapest first, so a flood of forgeries costs a counter and an
 * HMAC and never a database query (test plan SEC-18):
 *
 *   1. a per-network rate limit;
 *   2. the signature over the RAW body (read as text before any parse);
 *   3. only then JSON, and `lib/razorpay-webhook.ts`, which is idempotent on
 *      Razorpay's event id.
 *
 * Every verified delivery answers 200, including one it refused to apply
 * (unknown reference, wrong amount): Razorpay retries non-2xx for a day, and
 * retrying a refusal changes nothing. A database failure answers 500, which
 * Razorpay retries, and the retry applies it (the row stays unprocessed).
 */

export const dynamic = "force-dynamic"

/** Razorpay's deliveries are a few KB; anything near this is not one. */
const MAX_BODY_BYTES = 256 * 1024
const LIMIT = { max: 120, windowMs: 60_000 }

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

export async function POST(req: NextRequest) {
  const { count, resetAt } = await hit(`rzp-webhook:${clientNetworkFrom(req.headers)}`, LIMIT.windowMs)
  if (count > LIMIT.max) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } })
  }

  const secret = razorpayWebhookSecret()
  if (!secret) {
    // Ours to fix, and it would otherwise read like an attack in the logs.
    logger.error("Razorpay webhook rejected: RAZORPAY_WEBHOOK_SECRET is not set", {})
    return fail(401, "unauthorized")
  }

  const declared = Number(req.headers.get("content-length") ?? "0")
  if (declared > MAX_BODY_BYTES) return fail(413, "too_large")
  const raw = await req.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return fail(413, "too_large")

  // Nothing in the answer says which part failed: missing, malformed and
  // wrong are one 401.
  if (!verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"), secret)) {
    return fail(401, "unauthorized")
  }

  const eventId = req.headers.get("x-razorpay-event-id")?.trim()
  let delivery: unknown
  try {
    delivery = JSON.parse(raw)
  } catch {
    return fail(400, "malformed")
  }
  if (
    !eventId ||
    typeof delivery !== "object" ||
    delivery === null ||
    typeof (delivery as { event?: unknown }).event !== "string"
  ) {
    return fail(400, "malformed")
  }

  const result = await recordRazorpayDelivery(eventId, delivery as Parameters<typeof recordRazorpayDelivery>[1])
  return NextResponse.json({ ok: true, ...result })
}
