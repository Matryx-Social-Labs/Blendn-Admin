const mockDb = {
  organisation_domains: { findFirst: jest.fn() },
  domain_email_tokens: { create: jest.fn() },
  organisation_members: { findFirst: jest.fn(), findUnique: jest.fn() },
  audit_logs: { create: jest.fn() },
}
const mockAuth = jest.fn()
const mockSend = jest.fn()
const mockTemplate = jest.fn((..._args: string[]) => ({ subject: "s", text: "t" }))

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSend(...args),
  emailConfigured: () => true,
  domainVerifyEmail: (...args: string[]) => mockTemplate(...args),
  inviteEmail: () => ({ subject: "s", text: "t" }),
  appUrl: () => "http://localhost",
}))

import { sendDomainVerifyEmail } from "@/lib/org-actions"

const ORG = "org_1"
const DOMAIN = { id: "dom_1", domain: "acme.com", verified_at: null }

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "organizer" } })
  mockDb.organisation_members.findFirst.mockResolvedValue({ org_id: ORG, role: "owner" })
  mockDb.organisation_members.findUnique.mockResolvedValue({ role: "owner" })
  mockDb.organisation_domains.findFirst.mockResolvedValue(DOMAIN)
  mockSend.mockResolvedValue({ sent: true })
  mockTemplate.mockReturnValue({ subject: "s", text: "t" })
})

/**
 * Who the verification link may be sent to.
 *
 * The whole basis of this proof is that `postmaster@` and its siblings are
 * addresses an individual employee does not get to own. Sending to a personal
 * address would verify that one person works at the company — a different
 * claim, and precisely the one an attacker with any mailbox at a large company
 * would like to make.
 */
describe("who may receive a domain verification link", () => {
  it("refuses a personal address", async () => {
    const result = await sendDomainVerifyEmail(ORG, "dom_1", "sagar@acme.com")
    expect(result.ok).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockDb.domain_email_tokens.create).not.toHaveBeenCalled()
  })

  it("refuses a role address at a DIFFERENT domain", async () => {
    // `postmaster@` at a domain somebody else controls proves nothing about
    // this one, and is trivially obtainable.
    const result = await sendDomainVerifyEmail(ORG, "dom_1", "postmaster@evil.com")
    expect(result.ok).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("accepts a role address at the claimed domain", async () => {
    const result = await sendDomainVerifyEmail(ORG, "dom_1", "postmaster@acme.com")
    expect(result.ok).toBe(true)
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it("mints a token that is not the published TXT value", async () => {
    /*
     * `organisation_domains.verification_token` is the value the company
     * publishes in DNS, and it is kept after verification for re-checks. A link
     * built from it would be usable by anybody who can read the record.
     */
    mockDb.organisation_domains.findFirst.mockResolvedValue({
      ...DOMAIN,
      verification_token: "blendn-verify-public-value",
    })
    await sendDomainVerifyEmail(ORG, "dom_1", "admin@acme.com")

    /*
     * Asserted on the LINK, not on the stored hash.
     *
     * A first version checked that `token_hash` did not contain the TXT value —
     * which is vacuous, because it is a SHA-256 and can never contain its own
     * input. The control caught it: reusing the published value left the test
     * green. What has to be true is that the secret in the emailed URL is not
     * the one published in DNS.
     */
    const [, link] = mockTemplate.mock.calls[0] as unknown as [string, string]
    expect(link).toContain("token=")
    expect(link).not.toContain("blendn-verify-public-value")

    const written = mockDb.domain_email_tokens.create.mock.calls[0][0].data
    expect(written.expires_at.getTime()).toBeGreaterThan(Date.now())
  })

  it("does not send to an already-verified domain", async () => {
    mockDb.organisation_domains.findFirst.mockResolvedValue({ ...DOMAIN, verified_at: new Date() })
    const result = await sendDomainVerifyEmail(ORG, "dom_1", "postmaster@acme.com")
    expect(result.ok).toBe(true)
    expect(mockSend).not.toHaveBeenCalled()
  })
})
