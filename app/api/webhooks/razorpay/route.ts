import { createHash } from "crypto"
import { NextResponse, type NextRequest } from "next/server"

import { clientNetworkFrom } from "@/lib/client-ip"
import { razorpayWebhookSecret } from "@/lib/env"
import { logger } from "@/lib/logger"
import { hit } from "@/lib/rate-limit-store"
import { verifyWebhookSignature } from "@/lib/razorpay"
import { deliverySchema, recordRazorpayDelivery } from "@/lib/razorpay-webhook"

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
 *   1. the body, read as bytes through a capped stream (a chunked body with no
 *      Content-Length is cut off at the cap, never buffered whole);
 *   2. the signature over those raw bytes. A network that keeps sending bad
 *      signatures is rate-limited; a valid delivery is never counted, so a
 *      legitimate burst of Razorpay retries is never 429'd;
 *   3. only then JSON, its shape (zod), and `lib/razorpay-webhook.ts`, which
 *      is idempotent on Razorpay's event id and on the body's hash.
 *
 * Every verified delivery answers 200, including one it refused to apply
 * (unknown reference, wrong amount): Razorpay retries non-2xx for a day and
 * then disables the webhook, and retrying a refusal changes nothing. A
 * database failure answers 500, which Razorpay retries; the transaction rolled
 * the claim back, so the retry applies it. docs/BILLING-RUNBOOK.md covers the
 * alerting and the replay.
 */

export const dynamic = "force-dynamic"

/** Razorpay's deliveries are a few KB; anything near this is not one. */
const MAX_BODY_BYTES = 256 * 1024
const BAD_SIGNATURES = { max: 30, windowMs: 60_000 }

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/** The body as bytes, or null once it passes `max` (the rest is never read). */
async function readCapped(req: NextRequest, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function POST(req: NextRequest) {
  const network = `rzp-webhook-bad:${clientNetworkFrom(req.headers)}`
  const secret = razorpayWebhookSecret()
  if (!secret) {
    // Ours to fix, and it would otherwise read like an attack in the logs.
    logger.error("Razorpay webhook rejected: RAZORPAY_WEBHOOK_SECRET is not set", {})
    return fail(401, "unauthorized")
  }

  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return fail(413, "too_large")
  const raw = await readCapped(req, MAX_BODY_BYTES)
  if (raw === null) return fail(413, "too_large")

  // Nothing in the answer says which part failed: missing, malformed and
  // wrong are one 401. Only failures count toward the limit.
  if (!verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"), secret)) {
    const { count, resetAt } = await hit(network, BAD_SIGNATURES.windowMs)
    if (count > BAD_SIGNATURES.max) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } })
    }
    return fail(401, "unauthorized")
  }

  const eventId = req.headers.get("x-razorpay-event-id")?.trim()
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(raw).toString("utf8"))
  } catch {
    return fail(400, "malformed")
  }
  const delivery = deliverySchema.safeParse(json)
  if (!eventId || eventId.length > 100 || !delivery.success) return fail(400, "malformed")

  const bodySha256 = createHash("sha256").update(raw).digest("hex")
  const result = await recordRazorpayDelivery(eventId, bodySha256, delivery.data)
  return NextResponse.json({ ok: true, ...result })
}
