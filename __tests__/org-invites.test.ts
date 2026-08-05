import {
  hashInviteToken,
  newInviteToken,
  inviteState,
  emailDomain,
  isFreeProvider,
  onboardingTier,
  canSubmitApplication,
  normaliseDomain,
  invitePolicy,
} from "@/lib/org-invites"

/**
 * The invite path is the way into someone else's company dashboard, so its
 * rules are asserted before they are written.
 *
 * Three separate things can go wrong here and only one of them looks like a
 * bug in testing:
 *
 *   1. a token that still works after being used, or after expiry
 *   2. a token that works for whoever holds it rather than who it was sent to
 *   3. an invite outside the verified domain going out with no reason recorded
 *
 * The first two are silent — the invite works, which is what a manual test
 * checks. Only the audit trail would ever show it, months later.
 */

describe("invite tokens", () => {
  it("never stores the token itself", () => {
    const token = newInviteToken()
    const hash = hashInviteToken(token)
    expect(hash).not.toContain(token)
    expect(hash).toHaveLength(64) // sha256 hex
  })

  it("hashes deterministically, so a presented token can be looked up", () => {
    const token = newInviteToken()
    expect(hashInviteToken(token)).toBe(hashInviteToken(token))
  })

  it("generates a different token every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newInviteToken()))
    expect(seen.size).toBe(200)
  })

  it("generates tokens long enough not to be guessed", () => {
    // 32 bytes base64url. Anything shorter is brute-forceable against an
    // endpoint that does not rate-limit per token.
    expect(newInviteToken().length).toBeGreaterThanOrEqual(40)
  })
})

describe("inviteState — a token is single-use and time-bound", () => {
  const future = new Date(Date.now() + 60_000)
  const past = new Date(Date.now() - 60_000)
  const base = { email: "a@acme.com", expires_at: future, accepted_at: null, revoked_at: null }

  it("accepts a live invite for the right person", () => {
    expect(inviteState(base, "a@acme.com")).toBe("valid")
  })

  it("refuses an invite that was already accepted", () => {
    expect(inviteState({ ...base, accepted_at: past }, "a@acme.com")).toBe("used")
  })

  it("refuses an expired invite", () => {
    expect(inviteState({ ...base, expires_at: past }, "a@acme.com")).toBe("expired")
  })

  it("refuses a revoked invite even before it expires", () => {
    expect(inviteState({ ...base, revoked_at: past }, "a@acme.com")).toBe("revoked")
  })

  it("refuses a valid token presented by the wrong person", () => {
    // The forwarded-link case. Without this the token is a bearer credential
    // and anyone in the recipient's inbox thread can walk in.
    expect(inviteState(base, "someone.else@acme.com")).toBe("wrong_recipient")
  })

  it("matches the recipient case-insensitively", () => {
    expect(inviteState({ ...base, email: "A@Acme.com" }, "a@acme.com")).toBe("valid")
  })

  it("reports used before expired when both apply", () => {
    // Ordering matters only for the message shown; an accepted-then-expired
    // token must never come back valid either way.
    expect(inviteState({ ...base, expires_at: past, accepted_at: past }, "a@acme.com")).toBe("used")
  })
})

describe("email domains", () => {
  it("extracts and lowercases the domain", () => {
    expect(emailDomain("Person@Byg-Brewski.COM")).toBe("byg-brewski.com")
  })

  it("returns null for something that is not an address", () => {
    for (const bad of ["", "no-at-sign", "@nolocal.com", "trailing@", "a@b@c.com"]) {
      expect(emailDomain(bad)).toBeNull()
    }
  })

  it("knows the free providers common in India", () => {
    for (const d of ["gmail.com", "yahoo.com", "yahoo.in", "outlook.com", "hotmail.com", "rediffmail.com", "proton.me", "icloud.com"]) {
      expect(isFreeProvider(d)).toBe(true)
    }
  })

  it("treats a company domain as not free", () => {
    for (const d of ["bygbrewski.com", "zomato.com", "acme.co.in"]) {
      expect(isFreeProvider(d)).toBe(false)
    }
  })

  it("does not mistake a company domain that merely contains a provider name", () => {
    // `gmail-marketing.com` is a real company domain shape and must not be
    // classed as free by a substring match.
    expect(isFreeProvider("gmail-marketing.com")).toBe(false)
    expect(isFreeProvider("notgmail.com")).toBe(false)
  })
})

describe("normaliseDomain", () => {
  it("strips protocol, www, path, port and case", () => {
    for (const input of [
      "https://www.BygBrewski.com/venues",
      "BYGBREWSKI.com",
      "http://bygbrewski.com:8080",
      "  bygbrewski.com  ",
    ]) {
      expect(normaliseDomain(input)).toBe("bygbrewski.com")
    }
  })

  it("rejects things that are not domains", () => {
    for (const bad of ["", "localhost", "not a domain", "com", "..", "-acme.com"]) {
      expect(normaliseDomain(bad)).toBeNull()
    }
  })
})

describe("onboarding tier", () => {
  it("puts a company address in the domain tier", () => {
    expect(onboardingTier("events@bygbrewski.com")).toBe("domain")
  })

  it("puts a free-provider address in needs_proof", () => {
    expect(onboardingTier("someone@gmail.com")).toBe("needs_proof")
  })

  it("puts an unparseable address in needs_proof rather than failing open", () => {
    expect(onboardingTier("garbage")).toBe("needs_proof")
  })
})

describe("canSubmitApplication", () => {
  it("lets a company-domain application through with nothing else", () => {
    expect(canSubmitApplication({ contact_email: "a@bygbrewski.com" }).ok).toBe(true)
  })

  it("blocks a gmail application with neither GSTIN nor website", () => {
    const r = canSubmitApplication({ contact_email: "a@gmail.com" })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/GSTIN|website/i)
  })

  it("lets a gmail application through with a valid GSTIN", () => {
    expect(canSubmitApplication({ contact_email: "a@gmail.com", gstin: "29AABCU9603R1ZJ" }).ok).toBe(true)
  })

  it("lets a gmail application through with a website", () => {
    expect(canSubmitApplication({ contact_email: "a@gmail.com", website: "https://bygbrewski.com" }).ok).toBe(true)
  })

  it("does not accept a GSTIN that fails its checksum as proof", () => {
    // Otherwise the extra requirement is satisfied by typing 15 characters.
    // Same GSTIN as above with the check digit changed.
    const r = canSubmitApplication({ contact_email: "a@gmail.com", gstin: "29AABCU9603R1ZK" })
    expect(r.ok).toBe(false)
  })

  it("does not accept a blank website as proof", () => {
    expect(canSubmitApplication({ contact_email: "a@gmail.com", website: "   " }).ok).toBe(false)
  })

  it("requires a company kind to name its legal entity", () => {
    const r = canSubmitApplication({
      contact_email: "a@bygbrewski.com",
      kind: "company",
      legal_name: "",
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/legal/i)
  })
})

describe("invitePolicy — the honest limit", () => {
  // An org admin can invite whoever they like; what is enforceable is that
  // doing it outside the verified domain is deliberate and recorded.
  it("allows an in-domain invite with no reason", () => {
    const r = invitePolicy({ verifiedDomains: ["acme.com"], email: "new@acme.com" })
    expect(r.ok).toBe(true)
    expect(r.requiresReason).toBe(false)
  })

  it("refuses an out-of-domain invite with no reason", () => {
    const r = invitePolicy({ verifiedDomains: ["acme.com"], email: "contractor@gmail.com" })
    expect(r.ok).toBe(false)
    expect(r.requiresReason).toBe(true)
  })

  it("allows an out-of-domain invite when a reason is given", () => {
    const r = invitePolicy({
      verifiedDomains: ["acme.com"],
      email: "contractor@gmail.com",
      reason: "Freelance photographer for the Nov 12 event",
    })
    expect(r.ok).toBe(true)
    expect(r.requiresReason).toBe(true)
  })

  it("does not accept a whitespace reason as a reason", () => {
    const r = invitePolicy({
      verifiedDomains: ["acme.com"],
      email: "contractor@gmail.com",
      reason: "   ",
    })
    expect(r.ok).toBe(false)
  })

  it("does not accept a token reason", () => {
    // "ok" is not a reason. A minimum length is crude but it is the difference
    // between an audit trail and a checkbox.
    expect(
      invitePolicy({ verifiedDomains: ["acme.com"], email: "x@gmail.com", reason: "ok" }).ok
    ).toBe(false)
  })

  it("cannot restrict at all when the org has verified no domain", () => {
    // Nothing to compare against, so every invite is allowed without a reason.
    // Pretending otherwise would block orgs who have not verified from adding
    // anyone at all.
    const r = invitePolicy({ verifiedDomains: [], email: "anyone@gmail.com" })
    expect(r.ok).toBe(true)
    expect(r.requiresReason).toBe(false)
  })

  it("matches any of several verified domains", () => {
    const r = invitePolicy({ verifiedDomains: ["acme.com", "acme.co.in"], email: "a@acme.co.in" })
    expect(r.ok).toBe(true)
    expect(r.requiresReason).toBe(false)
  })

  it("does not treat a subdomain lookalike as in-domain", () => {
    // `acme.com.attacker.io` ends with nothing useful, but a naive endsWith
    // check on "acme.com" would pass `evil-acme.com`.
    for (const email of ["a@evil-acme.com", "a@acme.com.attacker.io"]) {
      expect(invitePolicy({ verifiedDomains: ["acme.com"], email }).requiresReason).toBe(true)
    }
  })
})
