import { logger } from "./logger"
import {
  approvedHtml,
  declinedHtml,
  domainVerifyHtml,
  inviteHtml,
  onboardingVerifyHtml,
} from "./email-html"

/**
 * Transactional email.
 *
 * Resend's REST API over `fetch` — no SDK. The SDK wraps one POST, and a
 * dependency that ships its own retry policy and error types is more surface
 * than the twenty lines it replaces.
 *
 * **Unconfigured is a first-class state, not an error.** Without
 * `RESEND_API_KEY` the app still runs and every flow that sends email still
 * completes; the caller gets `{ sent: false, reason: "not_configured" }` and
 * decides what to do. Onboarding, for instance, falls back to a platform admin
 * verifying by hand — which is the state the product is in today anyway.
 *
 * What must never happen is a silent swallow: an invite that reports success
 * while nothing was sent leaves someone waiting for a mail that is not coming.
 */

export interface SendResult {
  sent: boolean
  reason?: "not_configured" | "provider_error"
  detail?: string
  id?: string
}

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!emailFrom()
}

function emailFrom(): string | undefined {
  return process.env.EMAIL_FROM
}

/** Base URL for links in emails. Falls back to NEXTAUTH_URL, which is required. */
export function appUrl(): string {
  return (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/$/, "")
}

export async function sendEmail(opts: {
  to: string
  subject: string
  text: string
  html?: string
}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY
  const from = emailFrom()

  if (!key || !from) {
    // Logged at info, not error: an environment without email configured is a
    // valid environment, and this is how a developer gets the link locally.
    logger.info("Email not sent — RESEND_API_KEY/EMAIL_FROM unset", {
      to: opts.to,
      subject: opts.subject,
    })
    return { sent: false, reason: "not_configured" }
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        ...(opts.html ? { html: opts.html } : {}),
      }),
      // A hung mail provider must not hold a request open indefinitely.
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      logger.error("Email send failed", { status: res.status, detail: detail.slice(0, 300) })
      return { sent: false, reason: "provider_error", detail: `HTTP ${res.status}` }
    }

    const body = (await res.json().catch(() => ({}))) as { id?: string }
    return { sent: true, id: body.id }
  } catch (err) {
    logger.error("Email send threw", { error: err instanceof Error ? err.message : String(err) })
    return { sent: false, reason: "provider_error", detail: String(err) }
  }
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Each returns `subject`, `text` and `html`.
 *
 * Both parts are sent, not one or the other: Resend delivers them as multipart
 * and the client picks. The plain text is not a formality — it is what a
 * text-only client, a screen reader in plain mode, and a spam filter comparing
 * parts all read, and an HTML-only email scores worse for deliverability.
 *
 * The HTML lives in ./email-html.ts, which is table-layout and inline CSS
 * because Outlook renders with Word.
 */

export function onboardingVerifyEmail(name: string, link: string, orgName = "your organisation") {
  return {
    html: onboardingVerifyHtml(name, orgName, link),
    subject: "Confirm your email — Blend'n host application",
    text: [
      `Hi ${name},`,
      "",
      "Confirm this address to finish your Blend'n host application:",
      link,
      "",
      "The link expires in 24 hours. Once confirmed, our team reviews your application — you'll hear back by email.",
      "",
      "If you didn't apply, ignore this message. No account has been created.",
    ].join("\n"),
  }
}

export function inviteEmail(
  orgName: string,
  inviterName: string,
  link: string,
  roleLabel = "a member"
) {
  return {
    html: inviteHtml(orgName, inviterName, link, roleLabel),
    subject: `${inviterName} invited you to ${orgName} on Blend'n`,
    text: [
      `${inviterName} has invited you to join ${orgName} on Blend'n.`,
      "",
      link,
      "",
      "The link expires in 7 days and works only for this email address.",
      "",
      "If you weren't expecting this, ignore it — nothing happens until you accept.",
    ].join("\n"),
  }
}

export function approvedEmail(name: string, orgName: string, email: string, password: string) {
  return {
    html: approvedHtml(name, orgName, email, password),
    subject: "Your Blend'n host account is ready",
    text: [
      `Hi ${name},`,
      "",
      `${orgName} has been approved. You can sign in to the Blend'n dashboard now:`,
      `${appUrl()}/login`,
      "",
      `Email:    ${email}`,
      `Password: ${password}`,
      "",
      "Change the password after your first sign-in. You can invite colleagues from Organisation → Members.",
    ].join("\n"),
  }
}

export function declinedEmail(name: string, reason: string) {
  return {
    html: declinedHtml(name, reason),
    subject: "About your Blend'n host application",
    text: [
      `Hi ${name},`,
      "",
      "We're not able to approve your host application at the moment.",
      "",
      reason,
      "",
      "If you think this is a mistake, reply to this email with more detail about your organisation.",
    ].join("\n"),
  }
}

export function domainVerifyEmail(domain: string, link: string) {
  return {
    html: domainVerifyHtml(domain, link),
    subject: `Verify ${domain} for Blend'n`,
    text: [
      `Someone has asked to verify ${domain} for an organisation on Blend'n.`,
      "",
      "If that was you or someone at your organisation, confirm here:",
      link,
      "",
      "The link expires in 24 hours.",
      "",
      "If this wasn't expected, ignore it — the domain will not be verified.",
    ].join("\n"),
  }
}
