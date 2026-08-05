import { createHash, randomBytes } from "crypto"
import { validateGstin } from "./gstin"

/**
 * Invitations, domains, and the rules for who may apply.
 *
 * Pure functions only — no database, no email. The routes supply the rows and
 * this decides. That keeps every rule in __tests__/org-invites.test.ts, where
 * the ones that fail silently in manual testing (a reusable token, a token that
 * works for the wrong person) are actually observable.
 *
 * The honest limit, stated once: **nothing here stops an org admin inviting
 * whoever they want.** That is their company's call, exactly as it is in Slack
 * or Notion. What is enforceable — and what this file enforces — is that doing
 * it outside the verified domain is deliberate, reasoned, and recorded.
 */

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

/** 32 bytes. Long enough that guessing is not a strategy. */
export function newInviteToken(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Only the hash is stored. An invite token grants access to a company's
 * dashboard, so a database dump must not contain usable ones.
 */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export type InviteState = "valid" | "used" | "expired" | "revoked" | "wrong_recipient"

export interface InviteRow {
  email: string
  expires_at: Date
  accepted_at: Date | null
  revoked_at: Date | null
}

/**
 * Whether an invite may be accepted, by this person, now.
 *
 * The recipient check is what stops the token being a bearer credential: an
 * invite forwarded to a colleague, or sitting in a shared inbox, does not let
 * anyone else in. Checked before expiry so the message never confirms that a
 * token for *someone else* was at least real.
 */
export function inviteState(invite: InviteRow, presentedEmail: string, now = new Date()): InviteState {
  if (invite.email.trim().toLowerCase() !== presentedEmail.trim().toLowerCase()) {
    return "wrong_recipient"
  }
  if (invite.accepted_at) return "used"
  if (invite.revoked_at) return "revoked"
  if (invite.expires_at.getTime() <= now.getTime()) return "expired"
  return "valid"
}

/* -------------------------------------------------------------------------- */
/* Domains                                                                     */
/* -------------------------------------------------------------------------- */

export function emailDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@")
  if (parts.length !== 2) return null
  const [local, domain] = parts
  if (!local || !domain) return null
  return normaliseDomain(domain)
}

const DOMAIN_SHAPE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

/**
 * Reduce anything a user might paste to a bare apex domain.
 *
 * People type `https://www.acme.com/about` into a field labelled "domain", and
 * a claim on that string would never match the DNS lookup.
 */
export function normaliseDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase()
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // protocol
  d = d.split("/")[0].split("?")[0] // path, query
  d = d.split("@").pop() ?? d // pasted an address
  d = d.split(":")[0] // port
  d = d.replace(/^www\./, "").replace(/\.$/, "")
  return DOMAIN_SHAPE.test(d) ? d : null
}

/**
 * Free-provider addresses, matched as whole domains.
 *
 * A substring match would class `gmail-marketing.com` as free and reject a real
 * company. The list is deliberately short: it exists to decide whether an
 * applicant must supply extra proof, not to be exhaustive — anything missing
 * simply gets the easier path, and a human still reviews it.
 */
const FREE_PROVIDERS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.in", "yahoo.co.in", "ymail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "rediffmail.com", "rediff.com",
  "proton.me", "protonmail.com",
  "icloud.com", "me.com",
  "aol.com", "zoho.com", "mail.com", "gmx.com", "yandex.com",
])

export function isFreeProvider(domain: string): boolean {
  return FREE_PROVIDERS.has(domain.trim().toLowerCase())
}

/**
 * Does this address belong to one of the org's verified domains?
 *
 * Exact match on the normalised domain. `endsWith` would accept
 * `evil-acme.com` against `acme.com`, which is the whole attack.
 */
export function inVerifiedDomain(email: string, verifiedDomains: string[]): boolean {
  const domain = emailDomain(email)
  if (!domain) return false
  return verifiedDomains.some((d) => normaliseDomain(d) === domain)
}

/* -------------------------------------------------------------------------- */
/* Invite policy                                                               */
/* -------------------------------------------------------------------------- */

export interface InvitePolicyInput {
  verifiedDomains: string[]
  email: string
  reason?: string | null
}

export interface InvitePolicyResult {
  ok: boolean
  /** True when this address is outside the verified domain. */
  requiresReason: boolean
  message?: string
}

/** Short enough not to be a burden, long enough not to be "ok". */
const MIN_REASON = 8

export function invitePolicy({ verifiedDomains, email, reason }: InvitePolicyInput): InvitePolicyResult {
  const domains = verifiedDomains.map(normaliseDomain).filter((d): d is string => d !== null)

  // An org that has verified nothing has nothing to restrict against. Refusing
  // here would leave them unable to add their first colleague.
  if (domains.length === 0) return { ok: true, requiresReason: false }

  if (inVerifiedDomain(email, domains)) return { ok: true, requiresReason: false }

  if ((reason ?? "").trim().length < MIN_REASON) {
    return {
      ok: false,
      requiresReason: true,
      message: `${email} is outside ${domains.join(", ")}. Give a reason (recorded in the audit log) to invite them anyway.`,
    }
  }
  return { ok: true, requiresReason: true }
}

/* -------------------------------------------------------------------------- */
/* Application gating                                                          */
/* -------------------------------------------------------------------------- */

export type OnboardingTier = "domain" | "needs_proof"

/**
 * Which tier an application starts in.
 *
 * The tier decides what must be *supplied*, never whether a human looks — a
 * human always looks. An unparseable address falls to `needs_proof` rather
 * than failing open.
 */
export function onboardingTier(contactEmail: string): OnboardingTier {
  const domain = emailDomain(contactEmail)
  if (!domain) return "needs_proof"
  return isFreeProvider(domain) ? "needs_proof" : "domain"
}

export interface ApplicationInput {
  contact_email: string
  gstin?: string | null
  website?: string | null
  kind?: "individual" | "company"
  legal_name?: string | null
}

/**
 * Whether an application may be submitted at all.
 *
 * This is the anti-spam gate, and it is intentionally modest: a company email
 * passes freely, while a gmail address must carry something checkable. It
 * raises the cost of a throwaway signup without blocking the sole trader who
 * genuinely runs events from a personal address and has a website.
 */
export function canSubmitApplication(input: ApplicationInput): { ok: boolean; reason?: string } {
  if (!emailDomain(input.contact_email)) {
    return { ok: false, reason: "Enter a valid contact email address." }
  }

  if (input.kind === "company" && !(input.legal_name ?? "").trim()) {
    return { ok: false, reason: "A company must give its registered legal name." }
  }

  if (onboardingTier(input.contact_email) === "domain") return { ok: true }

  // A GSTIN only counts if it passes its checksum, otherwise the requirement is
  // satisfied by typing fifteen characters.
  const gstinOk = !!input.gstin?.trim() && validateGstin(input.gstin).valid
  const websiteOk = !!normaliseDomain(input.website ?? "")

  if (gstinOk || websiteOk) return { ok: true }

  return {
    ok: false,
    reason:
      "Applying from a personal email address, so we need one more thing: a GSTIN or your website. A company email address needs neither.",
  }
}
