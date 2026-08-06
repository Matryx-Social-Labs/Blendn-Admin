import {
  tokenOk,
  emailRoot,
  normaliseIp,
  leadInputSchema,
  LEAD_LIMITS,
  OPEN_LEAD_STATUSES,
} from "@/lib/leads"

/**
 * Lead ingest.
 *
 * The endpoint exists because the landing page used to return `{success:true}`
 * while dropping the lead. Every test here is ultimately about the same thing:
 * do not tell a visitor they are in unless they are.
 */

const TOKEN = "0123456789abcdef0123456789abcdef0123"

describe("tokenOk", () => {
  const original = process.env.LANDING_INGEST_TOKEN
  afterEach(() => {
    if (original === undefined) delete process.env.LANDING_INGEST_TOKEN
    else process.env.LANDING_INGEST_TOKEN = original
  })

  it("accepts the configured token", () => {
    process.env.LANDING_INGEST_TOKEN = TOKEN
    expect(tokenOk(`Bearer ${TOKEN}`)).toBe(true)
  })

  it("rejects everything when no token is configured", () => {
    // The failure mode this guards: an unset secret making `expected` undefined
    // and a naive comparison letting `Bearer undefined` through.
    delete process.env.LANDING_INGEST_TOKEN
    expect(tokenOk(`Bearer ${TOKEN}`)).toBe(false)
    expect(tokenOk("Bearer undefined")).toBe(false)
    expect(tokenOk("Bearer ")).toBe(false)
  })

  it("rejects a wrong token, a prefix, and a superstring", () => {
    process.env.LANDING_INGEST_TOKEN = TOKEN
    expect(tokenOk(`Bearer ${TOKEN}x`)).toBe(false)
    expect(tokenOk(`Bearer ${TOKEN.slice(0, -1)}`)).toBe(false)
    expect(tokenOk("Bearer " + "0".repeat(TOKEN.length))).toBe(false)
  })

  it("rejects a missing or malformed header rather than throwing", () => {
    process.env.LANDING_INGEST_TOKEN = TOKEN
    expect(tokenOk(undefined)).toBe(false)
    expect(tokenOk(null)).toBe(false)
    expect(tokenOk(TOKEN)).toBe(false) // no "Bearer " prefix
    expect(tokenOk("Basic " + TOKEN)).toBe(false)
  })

  it("accepts either token during a rotation", () => {
    // Rotation is two deploys: add the new one, update Vercel, drop the old.
    // Both must work in between or the window is an outage.
    const next = "ffffffffffffffffffffffffffffffffffff"
    process.env.LANDING_INGEST_TOKEN = `${TOKEN},${next}`
    expect(tokenOk(`Bearer ${TOKEN}`)).toBe(true)
    expect(tokenOk(`Bearer ${next}`)).toBe(true)
    expect(tokenOk("Bearer nope")).toBe(false)
  })

  it("ignores whitespace and empty entries in the rotation list", () => {
    process.env.LANDING_INGEST_TOKEN = ` ${TOKEN} , `
    expect(tokenOk(`Bearer ${TOKEN}`)).toBe(true)
    // An empty entry must not become a token that matches an empty bearer.
    expect(tokenOk("Bearer ")).toBe(false)
  })
})

describe("emailRoot — what the abuse counter keys on", () => {
  it("strips plus-addressing", () => {
    // The contract claimed a per-email cap would catch sam+1@/sam+2@. Keyed on
    // the raw address it cannot — they are different strings. This is the bit
    // that makes the rule mean something.
    expect(emailRoot("sam+1@example.com")).toBe("sam@example.com")
    expect(emailRoot("sam+2@example.com")).toBe("sam@example.com")
    expect(emailRoot("sam+anything+else@example.com")).toBe("sam@example.com")
  })

  it("lowercases both parts", () => {
    expect(emailRoot("Sam@Example.COM")).toBe("sam@example.com")
  })

  it("leaves an ordinary address alone", () => {
    expect(emailRoot("sam@example.com")).toBe("sam@example.com")
  })

  it("does not collapse a local part that is entirely a tag", () => {
    // "+foo@x.com" stripping to "@x.com" would put every such address in one
    // bucket and rate-limit them as if they were one person.
    expect(emailRoot("+foo@example.com")).toBe("+foo@example.com")
  })

  it("does not treat a plus in the domain as a tag", () => {
    expect(emailRoot("sam@ex+ample.com")).toBe("sam@ex+ample.com")
  })
})

describe("normaliseIp — a bad header must not cost a lead", () => {
  it("accepts IPv4 and IPv6", () => {
    expect(normaliseIp("203.0.113.7")).toBe("203.0.113.7")
    expect(normaliseIp("2001:db8::1")).toBe("2001:db8::1")
  })

  it("takes the first hop of a chain", () => {
    // Postgres INET rejects a comma-separated list outright.
    expect(normaliseIp("203.0.113.7, 70.41.3.18")).toBe("203.0.113.7")
  })

  it("returns null rather than a value INET would reject", () => {
    expect(normaliseIp("")).toBeNull()
    expect(normaliseIp(undefined)).toBeNull()
    expect(normaliseIp("not-an-ip")).toBeNull()
    expect(normaliseIp("999.1.1.1")).toBeNull()
    expect(normaliseIp("<script>")).toBeNull()
  })
})

describe("input validation", () => {
  const valid = {
    type: "demo_request",
    email: "Sam@Example.com",
    submittedAt: "2026-08-06T14:12:00.000Z",
  }

  it("lowercases and trims the email", () => {
    const parsed = leadInputSchema.parse({ ...valid, email: "  Sam@Example.com " })
    expect(parsed.email).toBe("sam@example.com")
  })

  it("rejects an invalid email", () => {
    expect(leadInputSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false)
  })

  it("ignores unknown fields rather than rejecting them", () => {
    // So the landing page can add a field without a coordinated deploy.
    const result = leadInputSchema.safeParse({ ...valid, somethingNew: "hello" })
    expect(result.success).toBe(true)
  })

  it("rejects an unknown lead type", () => {
    expect(leadInputSchema.safeParse({ ...valid, type: "newsletter" }).success).toBe(false)
  })

  it("rejects an over-long field rather than silently truncating", () => {
    // Truncation would store something the visitor did not write.
    expect(leadInputSchema.safeParse({ ...valid, userAgent: "x".repeat(401) }).success).toBe(false)
    expect(leadInputSchema.safeParse({ ...valid, eventTypes: "x".repeat(501) }).success).toBe(false)
  })

  it("accepts a lead with only the required fields", () => {
    // Everything but type and email is optional — a form with just an email is
    // still a lead worth having.
    expect(leadInputSchema.safeParse({ type: "demo_request", email: "s@x.com" }).success).toBe(true)
  })
})

describe("policy constants", () => {
  it("scopes idempotency to open leads only", () => {
    // Converted/archived/spam are excluded so a genuine returning request
    // creates a new row and fires its notification, instead of being shown
    // success and dropped.
    expect([...OPEN_LEAD_STATUSES]).toEqual(["new", "contacted", "qualified"])
    expect(OPEN_LEAD_STATUSES).not.toContain("converted")
    expect(OPEN_LEAD_STATUSES).not.toContain("archived")
  })

  it("keeps the per-email window longer than the per-IP one", () => {
    // An IP is shared (an office, a phone network); an email root is a person.
    expect(LEAD_LIMITS.perEmailRoot.windowMs).toBeGreaterThan(LEAD_LIMITS.perIp.windowMs)
  })
})
