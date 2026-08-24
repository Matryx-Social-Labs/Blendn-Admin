import { claimFlags, FLAG_COPY, type ClaimFlag } from "@/lib/claim-flags"

/**
 * What the automatic checks notice about a claim, and what they refuse to
 * decide.
 *
 * Approving hands a stranger the attendee list for an event, and `unclaimEvent`
 * can return the column but cannot un-see a roster. So this produces flags a
 * human reads — no score, no `autoApprove`, because a number invites somebody
 * to threshold it later.
 */

const facts = (o: Partial<Parameters<typeof claimFlags>[0]> = {}) => ({
  contactEmail: "priya@thehummingtree.com",
  sourceUrl: "https://thehummingtree.com/gigs/friday",
  verifiedDomains: [] as string[],
  priorClaims: 0,
  withoutOrg: false,
  ...o,
})

describe("the flag that matters most", () => {
  it("calls out an aggregator source, because a domain match then proves nothing", () => {
    /*
     * Without this, one address at a large ticketing platform matches the
     * source of EVERY event curated from it, and claims all of them. The
     * strongest-looking signal becomes the most dangerous one.
     */
    const f = claimFlags(facts({
      sourceUrl: "https://in.bookmyshow.com/events/xyz",
      contactEmail: "someone@bookmyshow.com",
    }))
    expect(f).toContain("source_is_aggregator")
    expect(f).toContain("email_matches_source")
  })

  it("puts it first, so a reviewer reads it before the evidence it invalidates", () => {
    /*
     * Ordering is load-bearing. A reviewer who reads "email matches source" and
     * stops has been misled; reading "source is an aggregator" first reframes
     * everything after it.
     */
    const f = claimFlags(facts({
      sourceUrl: "https://www.eventbrite.com/e/123",
      contactEmail: "admin@eventbrite.com",
    }))
    expect(f[0]).toBe("source_is_aggregator")
  })
})

describe("what counts as evidence", () => {
  it("treats a DNS-verified domain as the strongest signal", () => {
    /*
     * Decision 3a: `organisation_domains` stores DNS-TXT-verified, apex-only
     * domains. So "domain match" can mean *this org proved control via a TXT
     * record*, not *their email ends in it* — much harder to fake, the same
     * effort, and it is what makes a domain check defensible at all.
     */
    const f = claimFlags(facts({ verifiedDomains: ["thehummingtree.com"] }))
    expect(f).toContain("domain_verified_for_org")
  })

  it("accepts a subdomain of a verified apex", () => {
    const f = claimFlags(facts({
      contactEmail: "priya@mail.thehummingtree.com",
      verifiedDomains: ["thehummingtree.com"],
    }))
    expect(f).toContain("domain_verified_for_org")
  })

  it("does not match a domain that merely ends with the apex", () => {
    /*
     * `notthehummingtree.com` ends with `thehummingtree.com` as a string and is
     * a different company. Label-boundary matching, never `endsWith` — the same
     * trap the aggregator list documents.
     */
    const f = claimFlags(facts({
      contactEmail: "x@notthehummingtree.com",
      verifiedDomains: ["thehummingtree.com"],
    }))
    expect(f).not.toContain("domain_verified_for_org")
    expect(f).not.toContain("email_matches_source")
  })

  it("notices a role address at the source domain", () => {
    const f = claimFlags(facts({ contactEmail: "admin@thehummingtree.com" }))
    expect(f).toContain("role_address_at_source")
  })

  it("flags a free provider without treating it as suspicious", () => {
    // Not evidence either way. Most small organisers use gmail.
    const f = claimFlags(facts({ contactEmail: "someone@gmail.com" }))
    expect(f).toContain("free_email_provider")
    expect(f).not.toContain("email_matches_source")
  })
})

describe("the repeat count is the signal", () => {
  it("flags a claim somebody has filed before", () => {
    /*
     * `venue_claims` upserts and would show one row. A third claim on one event
     * is the most useful fact a reviewer has, and an upsert is exactly what
     * erases it.
     */
    expect(claimFlags(facts({ priorClaims: 2 }))).toContain("repeat_claim")
    expect(claimFlags(facts({ priorClaims: 0 }))).not.toContain("repeat_claim")
  })

  it("says when approval has to create the organisation first", () => {
    expect(claimFlags(facts({ withoutOrg: true }))).toContain("no_organisation_yet")
  })
})

describe("it decides nothing", () => {
  it("returns strings only — no score, no verdict", () => {
    const f = claimFlags(facts({ verifiedDomains: ["thehummingtree.com"] }))
    expect(Array.isArray(f)).toBe(true)
    for (const flag of f) expect(typeof flag).toBe("string")
  })

  it("has reviewer copy for every flag it can emit", () => {
    /*
     * Kept beside the rule so a new flag cannot ship without one. A queue full
     * of `source_is_aggregator` teaches nobody anything.
     */
    const emitted: ClaimFlag[] = [
      ...claimFlags(facts({ sourceUrl: "https://eventbrite.com/e/1", contactEmail: "admin@eventbrite.com" })),
      ...claimFlags(facts({ verifiedDomains: ["thehummingtree.com"], priorClaims: 1, withoutOrg: true })),
      ...claimFlags(facts({ contactEmail: "a@gmail.com" })),
    ]
    expect(emitted.length).toBeGreaterThan(4)
    for (const flag of emitted) {
      expect(FLAG_COPY[flag]).toBeTruthy()
    }
  })

  it("tolerates a malformed address without inventing a flag", () => {
    expect(claimFlags(facts({ contactEmail: "not-an-email" }))).toEqual([])
  })
})
