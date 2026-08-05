import {
  txtMatches,
  txtRecordValue,
  newDomainToken,
  isRoleAddressFor,
  roleAddressesFor,
  txtInstructions,
} from "@/lib/domain-verify"

/**
 * Domain verification decides whether an org may claim a domain as its own,
 * which decides who can be invited without an override. The matching is where
 * it can go wrong quietly: too strict and real registrars fail forever, too
 * loose and someone else's record verifies your claim.
 *
 * The live DNS call is not tested here — it is one `resolveTxt` and a try/catch,
 * and mocking the resolver would test the mock. The parsing around it is what
 * has edge cases, so that is what is pinned.
 */

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

describe("txtMatches", () => {
  it("matches the exact record", () => {
    expect(txtMatches([[`blendn-verify=${TOKEN}`]], TOKEN)).toBe(true)
  })

  it("finds our record among a domain's other TXT records", () => {
    // Every real domain already has SPF, DKIM, Google site verification...
    const records = [
      ["v=spf1 include:_spf.google.com ~all"],
      ["google-site-verification=abc123"],
      [`blendn-verify=${TOKEN}`],
    ]
    expect(txtMatches(records, TOKEN)).toBe(true)
  })

  it("joins a long record split across chunks", () => {
    // TXT strings are capped at 255 bytes and arrive chunked. Treating chunks
    // as separate records would never match.
    expect(txtMatches([["blendn-verify=", TOKEN]], TOKEN)).toBe(true)
  })

  it("tolerates surrounding quotes and whitespace from registrars", () => {
    for (const raw of [`"blendn-verify=${TOKEN}"`, `  blendn-verify=${TOKEN}  `]) {
      expect(txtMatches([[raw]], TOKEN)).toBe(true)
    }
  })

  it("does not match a different org's token", () => {
    expect(txtMatches([["blendn-verify=deadbeefdeadbeefdeadbeefdeadbeef"]], TOKEN)).toBe(false)
  })

  it("does not match when our token merely appears inside a longer record", () => {
    // A substring check would let someone verify by getting their token quoted
    // in any TXT record on the domain.
    expect(txtMatches([[`x=1 blendn-verify=${TOKEN} y=2`]], TOKEN)).toBe(false)
  })

  it("does not match an empty record set", () => {
    expect(txtMatches([], TOKEN)).toBe(false)
    expect(txtMatches([[""]], TOKEN)).toBe(false)
  })

  it("does not match the prefix with no token", () => {
    expect(txtMatches([["blendn-verify="]], TOKEN)).toBe(false)
  })
})

describe("tokens", () => {
  it("are unique", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newDomainToken()))
    expect(seen.size).toBe(200)
  })

  it("are hex and long enough not to be guessed", () => {
    expect(newDomainToken()).toMatch(/^[0-9a-f]{32}$/)
  })

  it("render into the documented record value", () => {
    expect(txtRecordValue(TOKEN)).toBe(`blendn-verify=${TOKEN}`)
  })
})

describe("txtInstructions", () => {
  it("gives the apex host, not the full domain, as the record name", () => {
    // Registrars want "@" here; typing the domain in creates
    // acme.com.acme.com and the check then fails with no explanation.
    const i = txtInstructions("acme.com", TOKEN)
    expect(i.host).toBe("@")
    expect(i.value).toBe(`blendn-verify=${TOKEN}`)
  })
})

describe("the email fallback only ever targets role addresses", () => {
  it("accepts a role address at the claimed domain", () => {
    for (const local of ["admin", "postmaster", "webmaster", "hostmaster"]) {
      expect(isRoleAddressFor(`${local}@acme.com`, "acme.com")).toBe(true)
    }
  })

  it("refuses an ordinary address at the claimed domain", () => {
    // This is the whole point of the fallback: anyone can have
    // sagar@acme.com at a company they merely work for. Only the role
    // addresses imply control of the domain.
    expect(isRoleAddressFor("sagar@acme.com", "acme.com")).toBe(false)
  })

  it("refuses a role address at a different domain", () => {
    expect(isRoleAddressFor("admin@attacker.io", "acme.com")).toBe(false)
  })

  it("refuses a lookalike domain", () => {
    for (const email of ["admin@evil-acme.com", "admin@acme.com.attacker.io"]) {
      expect(isRoleAddressFor(email, "acme.com")).toBe(false)
    }
  })

  it("matches case-insensitively", () => {
    expect(isRoleAddressFor("Admin@ACME.com", "acme.com")).toBe(true)
  })

  it("lists the addresses it will send to", () => {
    expect(roleAddressesFor("https://www.acme.com/")).toEqual([
      "admin@acme.com",
      "postmaster@acme.com",
      "webmaster@acme.com",
      "hostmaster@acme.com",
    ])
  })

  it("lists nothing for a domain it cannot parse", () => {
    expect(roleAddressesFor("not a domain")).toEqual([])
  })
})
