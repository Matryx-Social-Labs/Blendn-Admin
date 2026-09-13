import { clientIpFrom } from "@/lib/client-ip"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import { canSubmitApplication, onboardingTier, hashInviteToken, newInviteToken } from "@/lib/org-invites"
import { validateGstin } from "@/lib/gstin"
import { sendEmail, onboardingVerifyEmail, applyUrl, emailConfigured } from "@/lib/email"

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

export async function POST(req: NextRequest) {
  // 3 per hour per IP. An honest applicant submits once.
  const limited = await rateLimit(req, {
    windowMs: 60 * 60 * 1000,
    maxRequests: 3,
    keyGenerator: (r) =>
      `onboarding:apply:${clientIpFrom(r.headers)}`,
  })
  if (limited) return limited

  try {
    const parsed = applySchema.safeParse(await req.json())
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

    // Already a host? Say so plainly rather than queueing a duplicate.
    const existingUser = await db.user.findUnique({
      where: { email: input.contact_email },
      select: { role: true },
    })
    if (existingUser && existingUser.role !== "attendee") {
      return NextResponse.json(
        { success: false, error: "This email already has a Blend'n host account. Sign in instead." },
        { status: 409 }
      )
    }

    const pending = await db.organiser_onboarding_requests.findFirst({
      where: { contact_email: input.contact_email, status: { in: ["pending", "email_pending"] } },
      select: { id: true, status: true },
    })
    if (pending) {
      return NextResponse.json(
        {
          success: false,
          error:
            pending.status === "email_pending"
              ? "We've already emailed you a confirmation link for this address. Check your inbox."
              : "We already have an application from this address and it's being reviewed.",
        },
        { status: 409 }
      )
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
      const result = await sendEmail({
        to: input.contact_email,
        ...onboardingVerifyEmail(request.contact_name, link, request.display_name),
      })
      emailSent = result.sent
      if (!result.sent) {
        // The row exists and a reviewer can still act on it — surfacing a
        // failure to the applicant here would strand an application that is
        // actually fine.
        logger.error("Onboarding verification email failed", {
          requestId: request.id,
          reason: result.reason,
        })
      }
    }

    auditLog({
      action: "onboarding.applied",
      resource: "organiser_onboarding_request",
      resourceId: request.id,
      details: { tier, requested_role: input.requested_role, emailSent },
      ipAddress: getRequestIp(req),
    })

    return NextResponse.json({
      success: true,
      requestId: request.id,
      emailSent,
      message: emailSent
        ? "Check your email for a confirmation link."
        : "Application received. Our team will review it and get back to you by email.",
    })
  } catch (err) {
    logger.error("Onboarding apply failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ success: false, error: "Something went wrong." }, { status: 500 })
  }
}
