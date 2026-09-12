import { isFreeProvider } from "./org-invites"
import { isAggregatorSource, sourceDomain } from "./curation-sources"

/**
 * What the automatic checks noticed about a claim.
 *
 * ## Flags, never a decision
 *
 * Nothing here approves anything, and that is the design rather than a
 * limitation. Approving a claim hands a stranger the attendee list for an
 * event, and `unclaimEvent` can return the column but cannot un-see a roster.
 * The venue and sponsor queues already work this way — a reviewer reads the
 * flags and decides — and this is the third instance of that shape.
 *
 * So the output is a list of strings a human reads, ordered strongest-first,
 * and there is deliberately no `score` and no `autoApprove`. A number invites
 * somebody to thresholds it later.
 *
 * ## The one that matters most
 *
 * `source_is_aggregator`. The domain check compares the claimant's address
 * against the URL the event was curated from, and that is good evidence when
 * the source is the organiser's own site. When it is a ticketing platform, one
 * address at that platform matches the source of **every event curated from
 * it** — so the strongest-looking signal becomes the most dangerous one, and it
 * has to be called out rather than quietly counted.
 *
 * Pure: no database, no network, so every rule here is unit-testable and the
 * caller does the lookups.
 */

export type ClaimFlag =
  /** The source is a ticketing platform, so a domain match proves nothing. */
  | "source_is_aggregator"
  /** The claimant's domain is DNS-TXT verified for their organisation. */
  | "domain_verified_for_org"
  /** The claimant's email domain matches the source's. Weak on its own. */
  | "email_matches_source"
  /** A role address (admin@, postmaster@) at the source domain. */
  | "role_address_at_source"
  /** gmail, outlook and the like. Not suspicious; not evidence either. */
  | "free_email_provider"
  /** Somebody has claimed this event before. The count is the signal. */
  | "repeat_claim"
  /** No account yet — approval has to create the organisation first. */
  | "no_organisation_yet"

export interface ClaimFacts {
  contactEmail: string
  /** The event's `source_url`. */
  sourceUrl: string | null
  /** Apex domains this claimant's org has proved control of, lowercased. */
  verifiedDomains: readonly string[]
  /** Prior claims on this event, in any status, excluding this one. */
  priorClaims: number
  /** True when the claim carries an onboarding request instead of an org. */
  withoutOrg: boolean
}

/** The local part and domain of an address, lowercased. Null when malformed. */
function splitEmail(email: string): { local: string; domain: string } | null {
  const at = email.trim().toLowerCase().lastIndexOf("@")
  if (at <= 0 || at === email.trim().length - 1) return null
  const t = email.trim().toLowerCase()
  return { local: t.slice(0, at), domain: t.slice(at + 1) }
}

/**
 * Does `domain` sit at or under `apex`?
 *
 * Suffix matching on label boundaries, never `endsWith`: `notacme.com` ends
 * with `acme.com` as a string and is a different company. The same trap
 * `isAggregatorSource` documents.
 */
function underApex(domain: string, apex: string): boolean {
  return domain === apex || domain.endsWith(`.${apex}`)
}

/**
 * Are these two hosts the same organisation?
 *
 * Checked in **both** directions, because either can be the more specific one.
 * A listing at `in.bookmyshow.com` claimed from `someone@bookmyshow.com` is a
 * match, and so is the reverse — the source host is whatever the listing page
 * happened to be served from, and the email domain is whatever the company uses
 * for mail. Neither is reliably the apex.
 *
 * A one-directional check missed the first of those, which is the ordinary
 * shape for an aggregator subdomain and therefore exactly the case the
 * aggregator flag exists to catch. Found by a test asserting the pair should
 * match.
 *
 * Still label-boundary matching, so `notacme.com` and `acme.com` are unrelated
 * in both directions.
 */
function sameOrganisation(a: string, b: string): boolean {
  return underApex(a, b) || underApex(b, a)
}

const ROLE_LOCALS = new Set(["admin", "postmaster", "webmaster", "hostmaster", "info", "hello"])

export function claimFlags(facts: ClaimFacts): ClaimFlag[] {
  const flags: ClaimFlag[] = []
  const email = splitEmail(facts.contactEmail)
  const source = sourceDomain(facts.sourceUrl)

  /*
   * First, because it invalidates the evidence below it. A reviewer who reads
   * "email matches source" and stops has been misled; reading
   * "source is an aggregator" first reframes everything after it.
   */
  if (isAggregatorSource(facts.sourceUrl)) flags.push("source_is_aggregator")

  if (email) {
    // The strongest evidence available: a TXT record the claimant's org put
    // there. Not "their email ends in it" — control of the domain.
    if (facts.verifiedDomains.some((d) => underApex(email.domain, d))) {
      flags.push("domain_verified_for_org")
    }

    if (source && sameOrganisation(email.domain, source)) {
      flags.push("email_matches_source")
      if (ROLE_LOCALS.has(email.local)) flags.push("role_address_at_source")
    }

    if (isFreeProvider(email.domain)) flags.push("free_email_provider")
  }

  /*
   * The count is the point. `venue_claims` upserts and would show one row;
   * here a third claim on one event is the most useful fact a reviewer has,
   * and it is exactly what an upsert erases.
   */
  if (facts.priorClaims > 0) flags.push("repeat_claim")

  if (facts.withoutOrg) flags.push("no_organisation_yet")

  return flags
}

/**
 * Copy for a reviewer. Kept beside the rule so a new flag cannot ship without
 * one — a queue full of `source_is_aggregator` teaches nobody anything.
 */
export const FLAG_COPY: Record<ClaimFlag, string> = {
  source_is_aggregator:
    "Listed on a ticketing platform — a matching email domain proves nothing here. Ask for something else.",
  domain_verified_for_org:
    "Their organisation has proved control of this domain by DNS record.",
  email_matches_source: "Their email domain matches the listing's.",
  role_address_at_source: "Filed from a role address at the listing's domain.",
  free_email_provider: "Filed from a free email provider. Not suspicious, not evidence.",
  repeat_claim: "Somebody has claimed this event before.",
  no_organisation_yet: "No account yet — approve their application first; the hand-over then goes to that organisation.",
}
