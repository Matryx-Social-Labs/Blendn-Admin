import { clientNetworkFrom } from "@/lib/client-ip"
import { randomUUID } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { hit } from "@/lib/rate-limit-store"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { canSubmitApplication, onboardingTier, hashInviteToken, newInviteToken } from "@/lib/org-invites"
import { validateGstin } from "@/lib/gstin"
import { sendEmail, onboardingVerifyEmail, applyAgainEmail, applyUrl, appUrl, emailConfigured } from "@/lib/email"
import { readJson } from "@/lib/api-input"

/**
 * The public host application.
 *
 * This is the only unauthenticated write on the dashboard side, which makes it
 * the spam surface. Three things guard it, in increasing order of how much they
 * actually help:
 *
 *   1. IP rate limit — stops the trivial script
 *   2. tier gate — a free-provider address must supply a GSTIN or a website
 *   3. a human reviews every single one
 *
 * (3) is the real defence. (1) and (2) exist so a human is not reviewing four
 * thousand rows.
 *
 * Submitting creates NO account. It creates an application row; approval is
 * what creates the user, the organisation, and the membership together.
 */

const applySchema = z.object({
  kind: z.enum(["individual", "company"]).default("company"),
  requested_role: z.enum(["organizer", "venue_owner", "sponsor"]).default("organizer"),
  display_name: z.string().trim().min(2).max(120),
  legal_name: z.string().trim().max(200).optional(),
  gstin: z.string().trim().max(20).optional(),
  website: z.string().trim().max(200).optional(),
  address: z.string().trim().max(400).optional(),
  city: z.string().trim().max(100).optional(),
  contact_name: z.string().trim().min(2).max(120),
  contact_email: z.string().trim().toLowerCase().email().max(200),
  contact_phone: z.string().trim().max(20).optional(),
})

/** Blank strings arrive from empty form fields; treat them as absent. */
const blankToUndefined = (v: string | undefined) => (v?.trim() ? v.trim() : undefined)

/**
 * Every answer from here takes at least this long (M4): the branch that writes
 * an application and the one that finds an existing address do different
 * work, and the difference must not be a clock somebody can read.
 */
const MIN_RESPONSE_MS = 600

/** One "you already have an account / an application" email per address a day, whoever asks for it (M4). */
const APPLY_AGAIN_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Sent after the response, never awaited by it, the same way on both branches
 * (M4): a mail provider's latency is the other clock.
 */
function sendLater(message: Parameters<typeof sendEmail>[0], what: string): void {
  void sendEmail(message)
    .then((result) => {
      if (!result.sent) logger.error(`${what} email failed`, { reason: result.reason })
    })
    .catch((error: unknown) => logger.error(`${what} email failed`, { error: String(error) }))
}

/** Hold an answer until `MIN_RESPONSE_MS` has passed since `started`. */
async function padded(started: number, body: ReturnType<typeof appliedBody>): Promise<NextResponse> {
  const wait = MIN_RESPONSE_MS - (Date.now() - started)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  return NextResponse.json(body)
}

export async function POST(req: NextRequest) {
  const started = Date.now()
  // 3 per hour per IP. An honest applicant submits once.
  const limited = await rateLimit(req, {
    windowMs: 60 * 60 * 1000,
    maxRequests: 3,
    keyGenerator: (r) =>
      `onboarding:apply:${clientNetworkFrom(r.headers)}`,
  })
  if (limited) return limited

  try {
    const parsed = applySchema.safeParse(await readJson(req))
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid application" },
        { status: 400 }
      )
    }

    const input = parsed.data
    const gstin = blankToUndefined(input.gstin)?.toUpperCase()
    const website = blankToUndefined(input.website)

    // A venue owner is always a company — they hold a lease and a licence, and
    // an individual venue owner is a data-entry mistake rather than a real case.
    const kind = input.requested_role === "venue_owner" ? "company" : input.kind

    const gate = canSubmitApplication({
      contact_email: input.contact_email,
      gstin,
      website,
      kind,
      legal_name: input.legal_name,
    })
    if (!gate.ok) {
      return NextResponse.json({ success: false, error: gate.reason }, { status: 400 })
    }

    // A GSTIN that fails its checksum is refused at the door rather than
    // wasting a reviewer's time — but only if one was supplied at all.
    if (gstin && !validateGstin(gstin).valid) {
      return NextResponse.json(
        { success: false, error: "That GSTIN doesn't look right — check for a typo, or leave it blank." },
        { status: 400 }
      )
    }

    /*
     * Already a host, or already applied: the same answer as a new application
     * (step 18 security review, M4). The page used to say "This email already
     * has a Blend'n host account" with a 409, which told anyone who typed an
     * address whether it was an operator's. Now the page says "check your
     * email" to everyone, and the email to an existing address says what is
     * true for it — sign in, or we have your application. Nothing is queued
     * twice, and the id handed back names no application.
     */
    const existingUser = await db.user.findUnique({
      where: { email: input.contact_email },
      select: { role: true, email: true },
    })
    const pending = await db.organiser_onboarding_requests.findFirst({
      where: { contact_email: input.contact_email, status: { in: ["pending", "email_pending"] } },
      select: { contact_email: true },
    })
    const already: "account" | "pending" | null =
      existingUser && existingUser.role !== "attendee" ? "account" : pending ? "pending" : null
    if (already) {
      /*
       * To the address we hold, never the one typed (the lookup matched it, but
       * only our stored copy is sent to); with nothing the request wrote in it;
       * and once a day per address, so this cannot be pointed at a host to
       * flood their inbox — the per-network limit above is the other half.
       */
      const to = already === "account" ? existingUser!.email : pending!.contact_email
      const { count } = await hit(`onboarding:apply-again:${to}`, APPLY_AGAIN_WINDOW_MS)
      if (emailConfigured() && count === 1) sendLater({ to, ...applyAgainEmail(already, `${appUrl()}/login`) }, "Apply-again")
      return padded(started, appliedBody(randomUUID(), emailConfigured()))
    }

    const tier = onboardingTier(input.contact_email)

    const request = await db.organiser_onboarding_requests.create({
      data: {
        kind,
        requested_role: input.requested_role,
        display_name: input.display_name,
        /*
         * Spread, because `blankToUndefined` returns `undefined` to mean "the
         * applicant left this blank" and `strictUndefinedChecks` refuses that
         * as a value. Omitting the key is the same intent, stated in the way
         * Prisma accepts.
         *
         * These are the sites the flag caught and a static scan could not: the
         * source reads `address: blankToUndefined(input.address)`, which looks
         * like any other field. Nothing here contains the token `undefined`.
         */
        ...(blankToUndefined(input.legal_name) != null && {
          legal_name: blankToUndefined(input.legal_name),
        }),
        ...(gstin != null && { gstin }),
        ...(website != null && { website }),
        ...(blankToUndefined(input.address) != null && {
          address: blankToUndefined(input.address),
        }),
        ...(blankToUndefined(input.city) != null && { city: blankToUndefined(input.city) }),
        contact_name: input.contact_name,
        contact_email: input.contact_email,
        ...(blankToUndefined(input.contact_phone) != null && {
          contact_phone: blankToUndefined(input.contact_phone),
        }),
        tier,
        // Without email configured there is nothing to confirm against, so the
        // application goes straight to review and the queue shows the address
        // as unconfirmed. Better than parking it in a state nothing can leave.
        status: emailConfigured() ? "email_pending" : "pending",
      },
      select: { id: true, contact_name: true, display_name: true },
    })

    let emailSent = false
    if (emailConfigured()) {
      const token = newInviteToken()
      await db.onboarding_email_tokens.create({
        data: {
          token_hash: hashInviteToken(token),
          request_id: request.id,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      })
      // applyUrl(), not appUrl(): the confirmation lands on a public page that
      // needs no session, so it can live on the organiser marketing host.
      const link = `${applyUrl()}/apply/verify?token=${encodeURIComponent(token)}`
      // After the response, as the existing-address branch sends (M4). A
      // failure is logged: the row exists and a reviewer can still act on it,
      // and surfacing it here would strand an application that is fine.
      sendLater({ to: input.contact_email, ...onboardingVerifyEmail(request.contact_name, link, request.display_name) }, "Onboarding verification")
      emailSent = true
    }

    auditLog({
      action: "onboarding.applied",
      resource: "organiser_onboarding_request",
      resourceId: request.id,
      details: { tier, requested_role: input.requested_role, emailSent },
      ipAddress: getRequestIp(req),
    })

    return padded(started, appliedBody(request.id, emailSent))
  } catch (err) {
    logger.error("Onboarding apply failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ success: false, error: "Something went wrong." }, { status: 500 })
  }
}

/** What an application gets back — the same shape, and the same words, whatever the address already has (M4). */
function appliedBody(requestId: string, emailSent: boolean) {
  return {
    success: true,
    requestId,
    emailSent,
    message: emailSent
      ? "Check your email for a confirmation link."
      : "Application received. Our team will review it and get back to you by email.",
  }
}
