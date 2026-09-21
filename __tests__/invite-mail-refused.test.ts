const mockDb = {
  organisations: { findUniqueOrThrow: jest.fn() },
  organisation_members: { findFirst: jest.fn() },
  organisation_invites: { findFirst: jest.fn(), create: jest.fn() },
}
const mockAuth = jest.fn()
const mockSend = jest.fn()
const mockAudit = jest.fn()
let configured = true

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: (...a: unknown[]) => mockAudit(...a) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSend(...args),
  emailConfigured: () => configured,
  inviteEmail: () => ({ subject: "s", text: "t" }),
  domainVerifyEmail: () => ({ subject: "s", text: "t" }),
  appUrl: () => "http://localhost",
}))

import { inviteMember } from "@/lib/org-actions"

/*
 * An invite whose mail the provider refused says so (SCRUM-192).
 *
 * Driven on staging: an invite to an address Resend would not take came back
 * "Email isn't configured, so send them this link yourself" — while two other
 * mails from the same session had gone out. The organiser is sent off to
 * hand-deliver a link to an address that may not exist, instead of fixing it.
 */
beforeEach(() => {
  jest.clearAllMocks()
  configured = true
  mockAuth.mockResolvedValue({ user: { id: "u1", name: "Arjun", role: "organizer" } })
  mockDb.organisation_members.findFirst
    .mockResolvedValueOnce({ role: "owner" }) // requireOrgRole
    .mockResolvedValueOnce(null) // not already a member
  mockDb.organisations.findUniqueOrThrow.mockResolvedValue({
    display_name: "Nightshift",
    domains: [{ domain: "blendn.app" }],
  })
  mockDb.organisation_invites.findFirst.mockResolvedValue(null)
  mockDb.organisation_invites.create.mockResolvedValue({ id: "inv_1" })
})

describe("an invite that could not be emailed", () => {
  it("names the address when the provider refused it, and hands over the link", async () => {
    mockSend.mockResolvedValue({ sent: false, reason: "provider_error", detail: "HTTP 422" })
    const r = await inviteMember("org_1", "someone@blendn.app", "staff")
    expect(r.ok).toBe(true)
    expect(r.message).toContain("someone@blendn.app")
    expect(r.message).not.toMatch(/isn't configured/)
    expect(r.link).toMatch(/^http:\/\/localhost\/invite\?token=/)
    expect(r.emailFailure).toBe("provider_error")
    // The audit row says why, not just that it didn't.
    expect(mockAudit.mock.calls[0][0].details).toMatchObject({ emailSent: false, emailFailure: "provider_error" })
  })

  it("says the platform has no email only when it has none", async () => {
    configured = false
    const r = await inviteMember("org_1", "someone@blendn.app", "staff")
    expect(mockSend).not.toHaveBeenCalled()
    expect(r.message).toMatch(/isn't configured/)
    expect(r.emailFailure).toBe("not_configured")
    expect(r.link).toBeDefined()
  })

  it("returns neither a link nor a failure when the mail went out", async () => {
    mockSend.mockResolvedValue({ sent: true })
    const r = await inviteMember("org_1", "someone@blendn.app", "staff")
    expect(r.message).toBe("Invite sent to someone@blendn.app.")
    expect(r.link).toBeUndefined()
    expect(r.emailFailure).toBeUndefined()
  })
})
