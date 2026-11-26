import { randomUUID } from "crypto"

import { db } from "./db"
import { logger } from "./logger"
import { BILLING_PLANS, grossRupees, gstSplit, planDay, rupees } from "./billing-plans"
import { MIN_ATTENDEES } from "./connection-metrics"
import { dashboardHost, emailReplyTo, publicSiteOrigin } from "./env"
import {
  approvedHtml,
  freeWindowEndingHtml,
  claimDecisionHtml,
  declinedHtml,
  domainVerifyHtml,
  passwordResetHtml,
  applyAgainHtml,
  resultsHtml,
  inviteHtml,
  liveAlertHtml,
  onboardingVerifyHtml,
  ticketOrderHtml,
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
  reason?: "not_configured" | "provider_error" | "suppressed"
  detail?: string
  id?: string
}

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!emailFrom()
}

function emailFrom(): string | undefined {
  return process.env.EMAIL_FROM
}

/** Where the dashboard lives. Sign-in and every authenticated link uses this. */
export function appUrl(): string {
  return (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/$/, "")
}

/**
 * Where a *host-facing* link should point.
 *
 * The apply flow is marketing-adjacent — someone reading the organiser pitch on
 * `organizers.blendn.app` should stay there through applying and confirming,
 * rather than being thrown onto `api.blendn.app`, which is a strange domain to
 * hand a human.
 *
 * Set `PUBLIC_APPLY_URL` to that host and the apply emails follow. Unset, it is
 * `appUrl()` and nothing changes.
 *
 * **This is deliberately not used for the invite, the approval, or the domain
 * emails.** Those land on pages that need a NextAuth session, and the session
 * cookie is scoped to the dashboard host — pointing them elsewhere would break
 * acceptance for everyone, and it would break it silently, because the page
 * renders fine and only the accept fails.
 *
 * The intended shape is a rewrite (`organizers.blendn.app/apply/*` → this app)
 * rather than a second implementation of the form. `/apply` imports its tier
 * gate straight from `lib/org-invites` so the hint shown and the rule enforced
 * cannot drift; a re-implementation loses that, and the drift is invisible —
 * the form says "submit" and the server says 400.
 */
export function applyUrl(): string {
  const configured = process.env.PUBLIC_APPLY_URL?.trim()
  return configured ? configured.replace(/\/$/, "") : appUrl()
}

/**
 * The dashboard's own origin, for a link the mobile app hands to a browser.
 *
 * Not `appUrl()`: that is `NEXTAUTH_URL`, which has pointed at the API host
 * before (the lead emails built from it needed `middleware.ts`'s redirect when
 * the hosts split). `/claim/*` serves on either host, but the session cookie a
 * signed-in host would bring lives on the dashboard one, and the API host is
 * not a name to hand a person. Unsplit (local, single host), it is `appUrl()`.
 */
export function dashboardUrl(): string {
  const host = dashboardHost()
  if (!host) return appUrl()
  // A local split (DASHBOARD_HOST=localhost:3100) has no certificate.
  return `${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https"}://${host}`
}

/*
 * Outside production, mail goes only to our own and test domains (SCRUM-452).
 *
 * Staging has RESEND_API_KEY and EMAIL_FROM set, and its seed data carried
 * real businesses' addresses, so a tester deciding a seeded claim emailed a
 * real company — a gmail.com applicant got a staging mail on 2026-09-15.
 *
 * Production is Railway's environment named `production`; anything else,
 * including a laptop with no Railway environment at all, is not. The domain
 * matches exactly: a suffix match would let `evil-blendn.app` through.
 * EMAIL_ALLOWLIST adds exact addresses, for a tester's own inbox.
 */
const OWN_DOMAINS = new Set(["blendn.app", "matrixsociallabs.com", "resend.dev"])

/*
 * One bare address. Resend is handed the whole `to`, so a second "@", a list,
 * a quoted local part or a display name could end in blendn.app and still
 * reach somebody else; none of those shapes is let through.
 */
const ONE_ADDRESS = /^[^\s@,<>"]+@([^\s@,<>"]+)$/

function mayDeliverTo(to: string): boolean {
  if (process.env.RAILWAY_ENVIRONMENT_NAME === "production") return true
  const address = canonicalEmail(to)
  const domain = ONE_ADDRESS.exec(address)?.[1]
  if (!domain) return false
  const listed = (process.env.EMAIL_ALLOWLIST ?? "").split(",").map((a) => a.trim().toLowerCase())
  return OWN_DOMAINS.has(domain) || listed.includes(address)
}

/** A header value on one line: CR, LF and the other line breaks become spaces. */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ")
}

/**
 * The one form of an address: trimmed and lower-cased, which is how every account's address is stored (SCRUM-328) and
 * how sign-in and the password reset look it up. No Unicode folding and no `+tag` stripping: either would make two
 * stored accounts one string. `email_suppressions` is written and read in this form. Anything not a string is "".
 */
export function canonicalEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : ""
}

/**
 * Which mail a send is (SCRUM-1280). Unset is transactional: verification, invites, domain verification, claim and
 * application decisions, tickets, staff alerts. `password_reset` is a person asking for their own way back in;
 * `lifecycle` is the mail that carries List-Unsubscribe (growth 04b, 04c, 09a).
 */
export type MailStream = "password_reset" | "lifecycle"

/**
 * Whether a suppression stops this send. A hard bounce stops everything: the address does not exist. A complaint stops
 * everything but the reset, which the person asked for. An unsubscribe stops only the lifecycle mail it came from:
 * leaving the morning mail must not stop an org invite or a claim decision.
 */
function blocks(reason: string, stream: MailStream | undefined): boolean {
  if (reason === "unsubscribe") return stream === "lifecycle"
  return !(reason === "complaint" && stream === "password_reset")
}

/**
 * Fails open: a lookup that throws sends. A pilot guest's verification or reset matters more than one extra mail to a
 * bounced address, which Resend's own suppression list stops anyway.
 */
async function suppressed(to: string, stream: MailStream | undefined): Promise<boolean> {
  try {
    const row = await db.email_suppressions.findUnique({ where: { email: canonicalEmail(to) }, select: { reason: true } })
    return !!row && blocks(row.reason, stream)
  } catch (err) {
    logger.warn("Email suppression lookup failed; sending anyway", { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** Resend answers these again later (resend.com/docs/api-reference/errors); a 4xx is refused the same way twice. */
const retryable = (status: number) => status === 429 || status >= 500
/** About a second, plus up to half a second of jitter so a burst of failures does not retry in step. */
const retryDelay = () => 1_000 + Math.floor(Math.random() * 500)

export async function sendEmail(opts: {
  to: string
  subject: string
  text: string
  html?: string
  stream?: MailStream
  /** Extra headers (List-Unsubscribe); each value is made one line. */
  headers?: Record<string, string>
  /** Resend tags: names and values of ASCII letters, digits, `_` and `-`. */
  tags?: { name: string; value: string }[]
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

  if (!mayDeliverTo(opts.to)) {
    // "not_configured" rather than a new reason: this environment is not
    // configured to mail that address, and every caller already reads it as
    // not-sent (an invite hands over its link). The domain only — the address
    // is somebody's, and this is a log line. Not the subject either: a lead
    // alert's subject carries the person's name.
    logger.warn("Email not sent — recipient outside the non-production allowlist", {
      domain: opts.to.split("@").pop(),
    })
    return { sent: false, reason: "not_configured", detail: "recipient not allowlisted outside production" }
  }

  if (await suppressed(opts.to, opts.stream)) {
    // Info, not an error: the address bounced or complained, and not mailing it is the point. The domain only.
    logger.info("Email not sent — address suppressed", { domain: opts.to.split("@").pop(), stream: opts.stream })
    return { sent: false, reason: "suppressed" }
  }

  const replyTo = emailReplyTo()
  const body = JSON.stringify({
    from,
    // No CR/LF in anything a header is made of (step 18 security review,
    // M4): a subject or an address carrying one is a second header.
    to: [headerSafe(opts.to)],
    subject: headerSafe(opts.subject),
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
    ...(replyTo ? { reply_to: headerSafe(replyTo) } : {}),
    ...(opts.headers
      ? { headers: Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [headerSafe(k), headerSafe(v)])) }
      : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
  })
  // One key for both attempts: Resend answers a repeat with the first send's result and sends nothing again, so a retry
  // after an answer that was lost (a timeout, a 5xx after the mail went) is never a second mail.
  const idempotencyKey = randomUUID()

  // ponytail: one retry in the request, no outbox; a send that fails twice is logged and the caller's fallback runs.
  for (let attempt = 1; ; attempt++) {
    const last = attempt === 2
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body,
        // A hung mail provider must not hold a request open indefinitely.
        signal: AbortSignal.timeout(10_000),
      })

      if (res.ok) {
        const sent = (await res.json().catch(() => ({}))) as { id?: string }
        return { sent: true, id: sent.id }
      }
      const detail = await res.text().catch(() => "")
      if (last || !retryable(res.status)) {
        logger.error("Email send failed", { status: res.status, attempt, detail: detail.slice(0, 300) })
        return { sent: false, reason: "provider_error", detail: `HTTP ${res.status}` }
      }
    } catch (err) {
      // Not after our own timeout: the first send may still be in flight (a second would only get Resend's 409), and a
      // second ten seconds would double what an awaiting caller waits.
      if (last || (err instanceof Error && err.name === "TimeoutError")) {
        logger.error("Email send threw", { attempt, error: err instanceof Error ? err.message : String(err) })
        return { sent: false, reason: "provider_error", detail: String(err) }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay()))
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
    subject: "Confirm your email — Blend’n host application",
    text: [
      `Hi ${name},`,
      "",
      "Confirm this address to finish your Blend’n host application:",
      link,
      "",
      "The link expires in 24 hours. Once confirmed, our team reviews your application — you’ll hear back by email.",
      "",
      "If you didn’t apply, ignore this message. No account has been created.",
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
    subject: `${inviterName} invited you to ${orgName} on Blend’n`,
    text: [
      `${inviterName} has invited you to join ${orgName} on Blend’n.`,
      "",
      link,
      "",
      "The link expires in 7 days and works only for this email address.",
      "",
      "If you weren’t expecting this, ignore it — nothing happens until you accept.",
    ].join("\n"),
  }
}

/**
 * `setPasswordLink` is null for an account that already existed and keeps its
 * password. Never a password: see SCRUM-134.
 */
export function approvedEmail(name: string, orgName: string, email: string, setPasswordLink: string | null) {
  return {
    html: approvedHtml(name, orgName, email, setPasswordLink),
    subject: "Your Blend’n host account is ready",
    text: [
      `Hi ${name},`,
      "",
      `${orgName} has been approved. You can sign in to the Blend’n dashboard now:`,
      `${appUrl()}/login`,
      "",
      `Email: ${email}`,
      ...(setPasswordLink
        ? [
            "",
            "Set your password here — the link works once and expires in 24 hours:",
            setPasswordLink,
            "",
            "If it has expired, use \"Forgot password\" on the sign-in page and a fresh one will be sent.",
          ]
        : ["", "Sign in with your existing password."]),
      "",
      "You can invite colleagues from Organisation → Members.",
    ].join("\n"),
  }
}

export function declinedEmail(name: string, reason: string) {
  return {
    html: declinedHtml(name, reason),
    subject: "About your Blend’n host application",
    text: [
      `Hi ${name},`,
      "",
      "We’re not able to approve your host application at the moment.",
      "",
      reason,
      "",
      "If you think this is a mistake, reply to this email with more detail about your organisation.",
    ].join("\n"),
  }
}

export function claimDecisionEmail(
  name: string,
  what: string,
  outcome: "approved" | "declined",
  reason: string | null,
  link: string | null
) {
  const approved = outcome === "approved"
  return {
    html: claimDecisionHtml(name, what, outcome, reason, link),
    subject: approved ? `Your claim on ${what} was approved` : `About your claim on ${what}`,
    text: [
      `Hi ${name},`,
      "",
      approved
        ? `Your claim on ${what} has been approved. It now belongs to your organisation.`
        : `We’re not able to approve your claim on ${what}.`,
      ...(reason ? ["", reason] : []),
      ...(link ? ["", link] : []),
      "",
      approved
        ? "You can invite colleagues from Organisation → Members."
        : "If you think this is a mistake, reply to this email with more detail.",
    ].join("\n"),
  }
}

/**
 * See `applyAgainHtml`: an application from an address that already has an
 * account, or one under review. A fixed text with no name in it — anybody can
 * type an address into /apply, so nothing they typed reaches this email (M4).
 */
export function applyAgainEmail(kind: "account" | "pending", signInLink: string) {
  return {
    html: applyAgainHtml(kind, signInLink),
    subject: kind === "account" ? "You already have a Blend’n host account" : "We already have your Blend’n application",
    text: [
      "Hi,",
      "",
      kind === "account"
        ? "Somebody applied to host on Blend’n with this address, and it already has a host account. Sign in instead:"
        : "Somebody applied to host on Blend’n with this address, and we already have an application from it. A person is reviewing it, usually within two working days — you don’t need to apply again.",
      ...(kind === "account" ? [signInLink] : []),
      "",
      "Didn’t apply? Ignore this email. Nothing has changed on your account.",
    ].join("\n"),
  }
}

export function passwordResetEmail(name: string, link: string) {
  return {
    html: passwordResetHtml(name, link),
    subject: "Reset your Blend’n password",
    text: [
      `Hi ${name},`,
      "",
      "Someone asked to reset the password on your Blend’n account. Set a new one here:",
      link,
      "",
      "The link expires in one hour and can only be used once.",
      "",
      "Didn’t ask for this? Ignore this email — your password has not changed.",
    ].join("\n"),
  }
}

export function domainVerifyEmail(domain: string, link: string) {
  return {
    html: domainVerifyHtml(domain, link),
    subject: `Verify ${domain} for Blend’n`,
    text: [
      `Someone has asked to verify ${domain} for an organisation on Blend’n.`,
      "",
      "If that was you or someone at your organisation, confirm here:",
      link,
      "",
      "The link expires in 24 hours.",
      "",
      "If this wasn’t expected, ignore it — the domain will not be verified.",
    ].join("\n"),
  }
}

/**
 * A ticket order's news for its buyer (SCRUM-1011). The order reference is the
 * first eight characters of its id, what the buyer quotes; the pass itself is
 * in the app, never in an email.
 */
export function ticketOrderEmail(opts: { subject: string; heading: string; paragraphs: string[]; orderId: string }) {
  const link = publicSiteOrigin()
  const paragraphs = [...opts.paragraphs, `Order reference: ${opts.orderId.slice(0, 8).toUpperCase()}`]
  return {
    subject: opts.subject,
    text: [opts.heading, "", ...paragraphs.flatMap((p) => [p, ""]), link].join("\n"),
    html: ticketOrderHtml({ heading: opts.heading, paragraphs, link }),
  }
}

/**
 * The host's morning results mail (SCRUM-1282). Free figures only, each already through `lib/disclosure`'s floor by
 * the caller: `checkedIn` null is under the floor, `averageRating` null is fewer than five raters. No names, no
 * pseudonyms, no paid figure and no Plus (r-pricing "Do not"). No time either, so there is no zone to label.
 */
export interface NightResults {
  title: string
  checkedIn: number | null
  averageRating: number | null
  ratingCount: number
  moodMessages: number
  overviewUrl: string
  nextUrl: string
  unsubscribeUrl: string
}

const NEXT_LABEL = "List your next night"
/** Why each lifecycle mail came: its footer, in the text part and the HTML. */
const MORNING_WHY = "You get this the morning after each night your organization runs on Blend’n."
const NEXT_NIGHT_WHY = "You get this a week after a night with nothing listed next, at most once a month."
const footer = (why: string, unsubscribeUrl: string) => [
  "—",
  `${why} Invites and account mail still come.`,
  `Unsubscribe from these mails: ${unsubscribeUrl}`,
]
const count = (n: number) => n.toLocaleString("en-US")

export function resultsEmail(r: NightResults) {
  const lines = [
    r.checkedIn === null ? "Fewer than 5 people checked in on Blend’n." : `${count(r.checkedIn)} people checked in on Blend’n.`,
    r.averageRating === null
      ? "Guests are asked to rate the night today. The average shows on the results page once 5 people have rated."
      : `${r.averageRating.toFixed(1)} average rating from ${count(r.ratingCount)} people.`,
    ...(r.moodMessages > 0 ? [`The room’s mood, from ${count(r.moodMessages)} chat message${r.moodMessages === 1 ? "" : "s"}, is on the results page.`] : []),
  ]
  const note = r.checkedIn === null ? "Counts under 5 show as “fewer than 5”, so nobody can be picked out." : null
  const subject = `${r.title}: your night in numbers`
  return {
    subject,
    text: [
      `Here’s how ${r.title} went.`,
      "",
      ...lines,
      "",
      "Open the night’s results:",
      r.overviewUrl,
      "",
      `${NEXT_LABEL}:`,
      r.nextUrl,
      ...(note ? ["", note] : []),
      "",
      ...footer(MORNING_WHY, r.unsubscribeUrl),
    ].join("\n"),
    html: resultsHtml({
      title: subject,
      preheader: lines[0],
      heading: "Your night in numbers",
      lines: [`Here’s how ${r.title} went.`, ...lines],
      button: { href: r.overviewUrl, label: "Open the night’s results" },
      next: { href: r.nextUrl, label: NEXT_LABEL },
      note,
      why: MORNING_WHY,
      unsubscribeUrl: r.unsubscribeUrl,
    }),
  }
}

/**
 * Nobody checked in through the app (Fable advisor, 2026-11-26): sent for an organization's first mailed night only,
 * and "on Blend’n" throughout, never "nobody came", which a full room with no QR at the door would make false. The
 * one ask is the next night, so it is the button and there is no second link.
 */
export function noCheckInsEmail(r: { title: string; nextUrl: string; unsubscribeUrl: string }) {
  const lines = [
    `Nobody checked in on Blend’n at ${r.title}, so there are no figures to show you this morning.`,
    "That usually means guests didn’t see your door QR. Put it up at the entrance next time, from your event’s “QR & link” tab, and your check-ins, ratings and the room’s mood will be here the morning after.",
  ]
  const subject = `${r.title}: no check-ins on Blend’n`
  return {
    subject,
    text: [
      ...lines.flatMap((l) => [l, ""]),
      `${NEXT_LABEL}:`,
      r.nextUrl,
      "",
      ...footer(MORNING_WHY, r.unsubscribeUrl),
    ].join("\n"),
    html: resultsHtml({
      title: subject,
      preheader: "No figures this time. One thing to try at the door next time.",
      heading: "No check-ins this time",
      lines,
      button: { href: r.nextUrl, label: NEXT_LABEL },
      next: null,
      note: null,
      why: MORNING_WHY,
      unsubscribeUrl: r.unsubscribeUrl,
    }),
  }
}

/**
 * The "list your next" nudge (SCRUM-1284): a week after an organization's latest night, with nothing coming up. One line
 * on that night and one button; no second ask. `checkedIn` is through the disclosure floor (null: fewer than 5), and 0
 * means nobody checked in, so no figure is quoted at all.
 */
export function nextNightEmail(r: { title: string; checkedIn: number | null; nextUrl: string; unsubscribeUrl: string }) {
  const line =
    r.checkedIn === 0
      ? `It’s a week since ${r.title}, and nothing is listed after it yet.`
      : `${r.checkedIn === null ? "Fewer than 5" : count(r.checkedIn)} people checked in on Blend’n at ${r.title} last week. Nothing is listed after it yet.`
  const subject = `${r.title}: what’s next?`
  return {
    subject,
    text: [line, "", `${NEXT_LABEL}:`, r.nextUrl, "", ...footer(NEXT_NIGHT_WHY, r.unsubscribeUrl)].join("\n"),
    html: resultsHtml({
      title: subject,
      preheader: line,
      heading: "What’s next?",
      lines: [line],
      button: { href: r.nextUrl, label: NEXT_LABEL },
      next: null,
      note: null,
      why: NEXT_NIGHT_WHY,
      unsubscribeUrl: r.unsubscribeUrl,
    }),
  }
}

/**
 * A critical live alert, to the organizer's owners and admins (SCRUM-1286). `body` is the alert's own body as the Live
 * tab shows it (`deriveAlerts`, written down by the issue sweep), never a second version; `openedAt` is already on the
 * event's clock, with no zone label. Transactional: no unsubscribe, because a safety alert must not be lost with the
 * morning mail.
 */
export function liveAlertEmail(a: { eventTitle: string; alertTitle: string; body: string; openedAt: string; liveUrl: string }) {
  const subject = `${a.eventTitle}: ${a.alertTitle}`
  const lines = [a.body, `${a.eventTitle}, opened at ${a.openedAt}.`]
  const why = "You get this as an owner or admin of the organization running this night, once when a critical alert opens."
  return {
    subject,
    text: [...lines.flatMap((l) => [l, ""]), "Open the Live tab:", a.liveUrl, "", "—", why].join("\n"),
    html: liveAlertHtml({ title: subject, heading: a.alertTitle, lines, button: { href: a.liveUrl, label: "Open the Live tab" }, note: why }),
  }
}

/**
 * 14 days before an organisation's free Analytics ends (SCRUM-1275; DECISIONS
 * 2026-11-25, OWNER.md "When free months end": the views lock as coded and the
 * mail names today's prices). Prices from the price table, as /pricing shows
 * them: what is paid, then the GST split. No invoice is promised (none is
 * issued yet) and no figure of theirs is shown, blurred or otherwise.
 */
export function freeWindowEndingEmail(opts: { orgName: string; endsAt: Date }) {
  const date = planDay(opts.endsAt)
  const pass = BILLING_PLANS.event_pass
  const monthly = BILLING_PLANS.analytics_monthly
  const link = `${dashboardUrl()}/dashboard/plan`
  const heading = `Your free Analytics ends on ${date}`
  const paragraphs = [
    `Every Analytics view for ${opts.orgName} has been free so far. That ends on ${date}.`,
    [
      "Free for good:",
      "• Running events: listing, GPS check-in, the live room and its safety tools",
      "• Each event’s own numbers",
      `• The analytics of your first event with at least ${MIN_ATTENDEES} people checked in`,
    ].join("\n"),
    [
      `Locked from ${date}:`,
      "• Return rates and comparisons across your events",
      "• The deeper Event Insights of every other event",
    ].join("\n"),
    [
      "To keep them open:",
      `• Event Insights, one event, for good: ${rupees(grossRupees(pass))} once (${gstSplit(pass)})`,
      `• Analytics, all your events: ${rupees(grossRupees(monthly))} a month (${gstSplit(monthly)})`,
    ].join("\n"),
    "Nothing is deleted. Your events and their data are kept, and a view opens with its full history as soon as your payment is confirmed.",
  ]
  const note = `You’re getting this once, as an owner or admin of ${opts.orgName} on Blend’n.`
  return {
    subject: heading,
    text: [...paragraphs.flatMap((p) => [p, ""]), `See your plan: ${link}`, "", note].join("\n"),
    html: freeWindowEndingHtml({ heading, paragraphs, link, note }),
  }
}
