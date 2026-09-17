/*
 * `decideSponsorClaim`, invoked: the claimant hears the decision (SCRUM-117).
 * The venue and event queues have their own; this is the third form that said
 * "it is sent to the claimant" while nothing sent it.
 */
const mockDb = {
  sponsor_claims: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  sponsors: { findFirst: jest.fn(), update: jest.fn() },
  user: { findMany: jest.fn() },
  $transaction: jest.fn(),
}
mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => fn(mockDb))
const auditLog = jest.fn()
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/audit-log", () => ({ auditLog }))
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue({ user: { id: "admin", role: "app_admin" } }) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/org-membership", () => ({ actorFor: jest.fn() }))
const sent: { to: string; subject: string; text: string }[] = []
jest.mock("@/lib/email", () => {
  const actual = jest.requireActual("@/lib/email")
  return {
    ...actual,
    emailConfigured: () => true,
    sendEmail: jest.fn(async (m: { to: string; subject: string; text: string }) => {
      sent.push(m)
      return { sent: true }
    }),
  }
})

import { decideSponsorClaim } from "@/lib/sponsor-claim-actions"

beforeEach(() => {
  jest.clearAllMocks()
  sent.length = 0
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => fn(mockDb))
  mockDb.sponsor_claims.findUnique.mockResolvedValue({
    id: "sc1",
    status: "pending",
    org_id: "org1",
    is_dispute: false,
    filed_by: "meera",
    sponsor: { id: "s1", name: "Third Wave", name_key: "third wave", org_id: null },
  })
  mockDb.sponsor_claims.findMany.mockResolvedValue([{ filed_by: "rival" }])
  mockDb.sponsors.findFirst.mockResolvedValue(null)
  mockDb.user.findMany.mockResolvedValue([
    { id: "meera", email: "meera@bluetokai.test", name: "Meera" },
    { id: "rival", email: "rival@example.test", name: null },
  ])
})

it("a rejection reaches the claimant with the reason, and the toast can say so", async () => {
  const { notified } = await decideSponsorClaim("sc1", "reject", "This organisation already owns Blue Tokai — merge instead.")
  expect(notified).toBe(true)
  expect(sent).toEqual([expect.objectContaining({ to: "meera@bluetokai.test", subject: "About your claim on the brand Third Wave" })])
  expect(sent[0].text).toContain("merge instead")
  expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ emailSent: true }) }))
})

it("an approval tells the winner and the displaced claimant", async () => {
  await decideSponsorClaim("sc1", "approve")
  expect(sent.map((m) => [m.to, m.subject])).toEqual([
    ["meera@bluetokai.test", "Your claim on the brand Third Wave was approved"],
    ["rival@example.test", "About your claim on the brand Third Wave"],
  ])
  expect(sent[0].text).toContain("/dashboard/brand")
  expect(sent[1].text).toContain("Another claim on this brand was approved.")
})
