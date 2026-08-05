import { randomBytes } from "crypto"
import { resolveTxt } from "dns/promises"
import { normaliseDomain } from "./org-invites"

/**
 * Proving an organisation controls a domain.
 *
 * DNS TXT is the primary method because it is what only someone with access to
 * the domain's DNS can do. The email fallback exists because plenty of small
 * venues cannot edit their own DNS — it is weaker, but `admin@` and
 * `postmaster@` are not self-serve addresses either.
 *
 * Verification is what unlocks *restricting* invites to a domain. An
 * unverified org can still invite people; it just cannot claim a domain as
 * its own, and every invite it sends is unrestricted.
 */

export const TXT_PREFIX = "blendn-verify="

/** Role addresses that generally require control of the mail domain. */
export const ROLE_ADDRESSES = ["admin", "postmaster", "webmaster", "hostmaster"] as const

export function newDomainToken(): string {
  return randomBytes(16).toString("hex")
}

export function txtRecordValue(token: string): string {
  return `${TXT_PREFIX}${token}`
}

export type DomainCheck =
  | { verified: true }
  | { verified: false; reason: "no_records" | "not_found" | "lookup_failed"; detail?: string }

/**
 * Does the domain publish our token as a TXT record?
 *
 * Records are compared after trimming and lowercasing the prefix half only —
 * the token itself is hex, but registrars vary in whether they preserve
 * surrounding quotes and whitespace, and a verification that fails because
 * GoDaddy added a space is a support ticket, not a security boundary.
 */
export function txtMatches(records: string[][], token: string): boolean {
  const wanted = txtRecordValue(token).toLowerCase()
  return records.some((chunks) => {
    // A TXT record over 255 bytes arrives as multiple chunks that must be
    // concatenated, not treated as separate records.
    const value = chunks.join("").trim().replace(/^"|"$/g, "").toLowerCase()
    return value === wanted
  })
}

/**
 * Live DNS lookup. Network-dependent, so routes should treat a failure as
 * "not yet" rather than "never" — a transient resolver error must not delete
 * a pending claim.
 */
export async function checkDomainTxt(rawDomain: string, token: string): Promise<DomainCheck> {
  const domain = normaliseDomain(rawDomain)
  if (!domain) return { verified: false, reason: "lookup_failed", detail: "Not a valid domain." }

  try {
    const records = await resolveTxt(domain)
    if (records.length === 0) return { verified: false, reason: "no_records" }
    return txtMatches(records, token) ? { verified: true } : { verified: false, reason: "not_found" }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENODATA/ENOTFOUND are ordinary "nothing published yet" answers, which is
    // the normal state seconds after someone adds the record.
    if (code === "ENODATA" || code === "ENOTFOUND") return { verified: false, reason: "no_records" }
    return { verified: false, reason: "lookup_failed", detail: code ?? String(err) }
  }
}

/** What to show the person adding the record. */
export function txtInstructions(domain: string, token: string) {
  return {
    type: "TXT",
    host: "@",
    name: domain,
    value: txtRecordValue(token),
    note: "Add this at your DNS provider on the root of the domain. Propagation is usually minutes but can take up to an hour.",
  }
}

/**
 * Is this address one of the role addresses at the claimed domain?
 *
 * Used by the email fallback: we will only send a domain-verification token to
 * `admin@theirdomain.com`, never to an address they type in, or the fallback
 * would verify nothing at all.
 */
export function isRoleAddressFor(email: string, rawDomain: string): boolean {
  const domain = normaliseDomain(rawDomain)
  if (!domain) return false
  const [local, emailDomainPart] = email.trim().toLowerCase().split("@")
  if (!local || !emailDomainPart) return false
  if (normaliseDomain(emailDomainPart) !== domain) return false
  return (ROLE_ADDRESSES as readonly string[]).includes(local)
}

export function roleAddressesFor(rawDomain: string): string[] {
  const domain = normaliseDomain(rawDomain)
  return domain ? ROLE_ADDRESSES.map((r) => `${r}@${domain}`) : []
}
