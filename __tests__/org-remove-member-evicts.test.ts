const mockDb = {
  audit_logs: { create: jest.fn(), findFirst: async () => null },
  organisation_members: { findFirst: jest.fn(), count: jest.fn(), delete: jest.fn() },
  organisations: { findFirst: jest.fn() },
}
const mockAuth = jest.fn()
const mockEvict = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({ evictUserSockets: (...args: unknown[]) => mockEvict(...args) }))

import { removeMember } from "@/lib/org-actions"

/*
 * `join:eventOps` authorises once and the 5 s live tick emits to the room
 * without asking again, so a member removed from the organisation kept
 * receiving its events' sentiment, flag counts and check-in rate until they
 * closed the tab (SCRUM-939). Their dashboard sockets must go with the row;
 * the reconnect re-runs the handshake and the rejoin re-authorises.
 */
const ORG = "11111111-1111-4111-8111-111111111111"
const MEMBER_ROW = "22222222-2222-4222-8222-222222222222"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "organizer" } })
  mockDb.organisation_members.findFirst.mockResolvedValue({ id: MEMBER_ROW, role: "staff", user_id: "u2" })
  mockDb.organisation_members.count.mockResolvedValue(2)
  mockDb.organisation_members.delete.mockResolvedValue({})
})

describe("removeMember", () => {
  it("disconnects the removed person's dashboard sockets after the row is gone", async () => {
    mockDb.organisation_members.findFirst
      .mockResolvedValueOnce({ id: "caller", role: "owner", user_id: "u1" })
      .mockResolvedValueOnce({ id: MEMBER_ROW, role: "staff", user_id: "u2" })

    await removeMember(ORG, MEMBER_ROW)

    expect(mockDb.organisation_members.delete).toHaveBeenCalledWith({ where: { id: MEMBER_ROW } })
    expect(mockEvict).toHaveBeenCalledWith("u2", "dashboard")
    expect(mockDb.organisation_members.delete.mock.invocationCallOrder[0]).toBeLessThan(mockEvict.mock.invocationCallOrder[0])
  })

  it("evicts nobody when the member is not in this organisation", async () => {
    mockDb.organisation_members.findFirst
      .mockResolvedValueOnce({ id: "caller", role: "owner", user_id: "u1" })
      .mockResolvedValueOnce(null)

    await expect(removeMember(ORG, MEMBER_ROW)).rejects.toThrow("Not a member")
    expect(mockEvict).not.toHaveBeenCalled()
  })
})
