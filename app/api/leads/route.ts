import { NextResponse, type NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { hit } from "@/lib/rate-limit-store"
import {
  LEAD_LIMITS,
  emailRoot,
  leadInputSchema,
  normaliseIp,
  openKey,
  openKeyFor,
  tokenOk,
} from "@/lib/leads"
import { notifyNewLead } from "@/lib/lead-notify"

/**
 * POST /api/leads — ingest from the organiser landing page.
 *
 * Server-to-server only. See `lib/leads.ts` for why there is no CORS here and
 * why the token comparison is constant-time.
 *
 * The contract this implements lives in the landing-page repo at
 * `docs/LEADS_API_CONTRACT.md`. Two deliberate departures, both because the
 * spec as written could not do what it said:
 *
 *   - **Rate limits key on the body, not the request IP.** Every lead arrives
 *     from one Vercel egress address, so `x-forwarded-for` would cap the world
 *     at five an hour.
 *   - **Idempotency is scoped to open leads.** A permanent unique key silently
 *     drops a returning request months later — the failure this endpoint was
 *     built to stop.
 */

export const dynamic = "force-dynamic"

function fail(status: number, error: string, detail?: string) {
  return NextResponse.json({ error, ...(detail ? { detail } : {}) }, { status })
}

export async function POST(req: NextRequest) {
  // 401 before anything else touches the database.
  if (!tokenOk(req.headers.get("authorization"))) {
    // Distinguish "misconfigured" from "wrong caller" in the log — the first is
    // ours to fix and would otherwise look like an attack.
    if (!process.env.LANDING_INGEST_TOKEN) {
      logger.error("Lead ingest rejected: LANDING_INGEST_TOKEN is not set", {})
    }
    return fail(401, "unauthorized")
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return fail(400, "validation_failed", "body is not valid JSON")
  }

  const parsed = leadInputSchema.safeParse(body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return fail(400, "validation_failed", `${first.path.join(".") || "body"} ${first.message}`)
  }
  const input = parsed.data

  const root = emailRoot(input.email)
  const ip = normaliseIp(input.ip)

  // Both limits key on the body. `ip` may be absent, in which case that limit
  // simply does not apply — a missing IP must not become one shared bucket
  // that every such lead falls into.
  const buckets = [
    ip ? { key: `lead:ip:${ip}`, ...LEAD_LIMITS.perIp } : null,
    { key: `lead:email:${root}`, ...LEAD_LIMITS.perEmailRoot },
  ].filter(Boolean) as { key: string; max: number; windowMs: number }[]

  for (const bucket of buckets) {
    const { count, resetAt } = await hit(bucket.key, bucket.windowMs)
    if (count > bucket.max) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      )
    }
  }

  const data = {
    type: input.type,
    source: input.source || "organizers-landing",
    email: input.email,
    email_root: root,
    name: input.name || null,
    organization: input.organization || null,
    event_types: input.eventTypes || null,
    city: input.city || null,
    user_agent: input.userAgent || null,
    ip,
    // Non-null while the lead is open; nulled when it closes. This column IS
    // the idempotency guarantee — see lib/leads.ts openKey().
    open_key: openKeyFor("new", input.type, input.email),
    submitted_at: input.submittedAt ? new Date(input.submittedAt) : new Date(),
  }

  try {
    const lead = await db.leads.create({ data, select: { id: true } })

    // After the write, never before. A notification for a lead that failed to
    // store is how you end up chasing someone who is not in the system.
    // Deliberately not awaited into the response: a Slack/SMTP outage must not
    // turn a stored lead into a 5xx, which the caller would show as an error.
    void notifyNewLead(lead.id).catch((err) =>
      logger.error("Lead stored but notification failed", {
        leadId: lead.id,
        error: err instanceof Error ? err.message : String(err),
      })
    )

    return NextResponse.json({ id: lead.id, duplicate: false }, { status: 201 })
  } catch (err) {
    // P2002 = the open_key unique index. A double-tap or a Vercel retry, which
    // is an expected outcome and not a fault — 500 here would make the landing
    // page show an error for a lead that is already safely stored.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.leads.findUnique({
        where: { open_key: openKey(input.type, input.email) },
        select: { id: true },
      })
      return NextResponse.json({ id: existing?.id ?? null, duplicate: true }, { status: 409 })
    }

    // Loud, and 5xx. The caller shows the visitor an error rather than a
    // success for something we did not keep.
    logger.error("Lead ingest failed", {
      error: err instanceof Error ? err.message : String(err),
      email_root: root,
    })
    return fail(500, "ingest_failed")
  }
}
