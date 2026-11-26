import { createHmac, timingSafeEqual } from "crypto"
import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"

import { clientNetworkFrom } from "@/lib/client-ip"
import { db } from "@/lib/db"
import { canonicalEmail } from "@/lib/email"
import { resendWebhookKey } from "@/lib/env"
import { logger } from "@/lib/logger"
import { hit } from "@/lib/rate-limit-store"
import { readCapped } from "@/lib/webhook-body"

/**
 * POST /api/webhooks/resend — Resend's hard bounces and spam complaints, kept in `email_suppressions` so `sendEmail`
 * stops mailing that address (SCRUM-1280, launch gate 14). Which sends a row stops is `blocks` in lib/email.ts.
 *
 * Outside `/api/mobile` and outside `middleware.ts`'s matcher on purpose, like the Razorpay and RevenueCat webhooks:
 * no CORS, no session. Only POST is exported, so any other method is a 405.
 *
 * In order, cheapest first, so a flood of forgeries costs a counter and an HMAC and never a database query:
 *
 *   1. the body, read as bytes through a capped stream;
 *   2. the Svix signature over `<svix-id>.<svix-timestamp>.<raw body>` (docs.svix.com/receiving/verifying-payloads/
 *      how-manual), HMAC-SHA256 with the secret's decoded bytes, each `v1,` signature compared in constant time, and
 *      the timestamp within five minutes either way, so a captured delivery cannot be replayed later. Missing,
 *      malformed, wrong and stale are one 401. A network that keeps failing is rate-limited; a good delivery never
 *      counts;
 *   3. only then JSON. `email.bounced` with `bounce.type` `Permanent` (a hard bounce) and `email.complained` are
 *      written; a soft bounce and every other event are answered 200 and dropped.
 *
 * Unset secret: the webhook is off and everything is a 401 (logged once per process).
 *
 * A write is an upsert on the address, so Svix's retries and a replay inside the window stay one row. A stronger reason
 * replaces a weaker one (bounce over complaint over unsubscribe), never the other way.
 */

export const dynamic = "force-dynamic"

/** Resend's events are a few KB. */
const MAX_BODY_BYTES = 64 * 1024
const BAD_SIGNATURES = { max: 30, windowMs: 60_000 }
/** Svix's own libraries' tolerance. */
const TOLERANCE_SECONDS = 5 * 60
/** RFC 5321's longest path; anything longer is not an address. */
const MAX_ADDRESS = 320

let reportedUnset = false

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

function verified(raw: Uint8Array, headers: Headers, key: Buffer): boolean {
  const id = headers.get("svix-id")
  const timestamp = headers.get("svix-timestamp")
  const signatures = headers.get("svix-signature")
  if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false
  const want = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(raw).digest()
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",", 2)
    if (version !== "v1" || !signature) return false
    const got = Buffer.from(signature, "base64")
    return got.length === want.length && timingSafeEqual(got, want)
  })
}

const eventSchema = z.object({
  type: z.string(),
  data: z
    .object({
      to: z.union([z.string(), z.array(z.string())]).optional(),
      bounce: z.object({ type: z.string().optional() }).passthrough().optional(),
    })
    .passthrough(),
})

function reasonFor(event: z.infer<typeof eventSchema>): "bounce" | "complaint" | null {
  if (event.type === "email.complained") return "complaint"
  if (event.type === "email.bounced" && event.data.bounce?.type === "Permanent") return "bounce"
  return null
}

export async function POST(req: NextRequest) {
  const key = resendWebhookKey()
  if (!key) {
    if (!reportedUnset) {
      reportedUnset = true
      logger.error("Resend webhook rejected: RESEND_WEBHOOK_SECRET is not set (logged once)", {})
    }
    return fail(401, "unauthorized")
  }

  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return fail(413, "too_large")
  const raw = await readCapped(req, MAX_BODY_BYTES)
  if (raw === null) return fail(413, "too_large")

  if (!verified(raw, req.headers, key)) {
    const { count, resetAt } = await hit(`resend-webhook-bad:${clientNetworkFrom(req.headers)}`, BAD_SIGNATURES.windowMs)
    if (count > BAD_SIGNATURES.max) {
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
  const event = eventSchema.safeParse(json)
  if (!event.success) return fail(400, "malformed")

  const reason = reasonFor(event.data)
  if (!reason) return NextResponse.json({ ok: true, recorded: 0 })

  const to = event.data.data.to
  const emails = [...new Set((Array.isArray(to) ? to : [to ?? ""]).map(canonicalEmail))].filter(
    (e) => e.includes("@") && e.length <= MAX_ADDRESS
  )
  for (const email of emails) {
    // Insert, or raise the reason: an unsubscribe gives way to anything, a complaint to a bounce.
    await db.$executeRaw`
      INSERT INTO email_suppressions (email, reason) VALUES (${email}, ${reason})
      ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason
      WHERE email_suppressions.reason = 'unsubscribe' OR EXCLUDED.reason = 'bounce'`
  }
  // The domain only: the address is somebody's.
  logger.info("Resend webhook recorded a suppression", { reason, domains: emails.map((e) => e.split("@").pop()) })
  return NextResponse.json({ ok: true, recorded: emails.length })
}
