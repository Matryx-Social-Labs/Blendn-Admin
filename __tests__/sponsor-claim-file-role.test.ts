/*
 * SCRUM-652: an admin used to be admitted to `fileSponsorClaim` and then
 * refused one step later with "not attached to an organisation yet" — the
 * resolver gives an admin no organisations. The refusal now comes first and
 * says what is true: filing is for a sponsor account.
 */
const mockDb = { user: { findUnique: jest.fn() }, sponsors: { findUnique: jest.fn() }, sponsor_claims: { create: jest.fn() } }
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn(), auditInTx: jest.fn() }))
const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: mockAuth }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/org-membership", () => ({ actorFor: jest.fn().mockResolvedValue({ orgIds: [] }) }))

import { fileSponsorClaim } from "@/lib/sponsor-claim-actions"

const input = { sponsorId: "s1", evidence: { authorisation: "https://example.com/letter.pdf" } }

describe("fileSponsorClaim by role", () => {
  it("tells an admin that filing is for a sponsor account, before anything else", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin", role: "app_admin", signedInAt: 0 } })
    await expect(fileSponsorClaim(input as never)).rejects.toThrow("Only a sponsor account can claim a brand.")
    expect(mockDb.sponsors.findUnique).not.toHaveBeenCalled()
  })

  it("still refuses an organiser the same way", async () => {
    mockAuth.mockResolvedValue({ user: { id: "o", role: "organizer", signedInAt: 0 } })
    await expect(fileSponsorClaim(input as never)).rejects.toThrow("Only a sponsor account can claim a brand.")
  })
})
