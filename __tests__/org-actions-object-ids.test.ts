const mockDb = {
  audit_logs: { create: jest.fn(), findFirst: async () => null },
  organisation_members: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn(), delete: jest.fn() },
  organisation_invites: { updateMany: jest.fn(), findMany: jest.fn() },
  organisation_domains: { findFirst: jest.fn(), deleteMany: jest.fn() },
  organisation_join_requests: { findFirst: jest.fn(), findMany: jest.fn() },
  organisations: { findFirst: jest.fn() },
}
const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({ evictUserSockets: jest.fn() }))

import { getOrgMembers, removeDomain, removeMember, revokeInvite, setMemberRole } from "@/lib/org-actions"
import { resolveSponsorGrant } from "@/lib/org-membership"

/*
 * A server action's arguments are whatever the client posts (Next's data-security
 * guide), and the Flight reply format carries plain objects. Prisma reads an
 * object where a string belongs as a filter: `{ org_id: { not: <uuid> } }` is
 * "every other organisation". Measured against Postgres (Prisma 7.10): findFirst
 * and deleteMany take it; findUnique refuses it.
 *
 * `requireOrgRole` found the caller's membership with `findFirst({ org_id })`, so
 * an owner of ANY organisation passed it with an object, and the action's own
 * `org_id: orgId` filter then reached every organisation: `revokeInvite` revoked
 * every pending invite on the platform, `removeDomain` deleted every domain, and
 * `setMemberRole` / `removeMember` reached another organisation's members
 * (Aikido AIK_ts_node_nosqli_injection, lib/org-actions.ts:397 and :679).
 *
 * The mocks answer as Postgres did: the membership lookup matches. What is
 * asserted is that nothing is asked at all.
 */
const ANY_OTHER_ORG = { not: "00000000-0000-4000-8000-000000000000" } as unknown as string
const ORG = "11111111-1111-4111-8111-111111111111"
const MEMBER = "22222222-2222-4222-8222-222222222222"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "organizer" } })
  mockDb.organisation_members.findFirst.mockResolvedValue({ id: MEMBER, role: "owner", user_id: "u2" })
  mockDb.organisation_members.findMany.mockResolvedValue([])
  mockDb.organisation_members.count.mockResolvedValue(5)
  mockDb.organisation_domains.findFirst.mockResolvedValue({ domain: "acme.com" })
  mockDb.organisation_invites.updateMany.mockResolvedValue({ count: 0 })
  mockDb.organisation_domains.deleteMany.mockResolvedValue({ count: 0 })
})

describe("an organisation id that is not an id is refused before any query", () => {
  it("revokeInvite: no platform-wide revoke", async () => {
    await expect(revokeInvite(ANY_OTHER_ORG, ANY_OTHER_ORG)).rejects.toThrow("Forbidden")
    expect(mockDb.organisation_members.findFirst).not.toHaveBeenCalled()
    expect(mockDb.organisation_invites.updateMany).not.toHaveBeenCalled()
  })

  it("removeDomain: no platform-wide delete", async () => {
    await expect(removeDomain(ANY_OTHER_ORG, ANY_OTHER_ORG)).rejects.toThrow("Forbidden")
    expect(mockDb.organisation_domains.deleteMany).not.toHaveBeenCalled()
  })

  it("setMemberRole and removeMember: no reach into another organisation", async () => {
    await expect(setMemberRole(ANY_OTHER_ORG, MEMBER, "staff")).rejects.toThrow("Forbidden")
    await expect(removeMember(ANY_OTHER_ORG, MEMBER)).rejects.toThrow("Forbidden")
    expect(mockDb.organisation_members.update).not.toHaveBeenCalled()
    expect(mockDb.organisation_members.delete).not.toHaveBeenCalled()
  })

  it("getOrgMembers: no roster of every organisation", async () => {
    await expect(getOrgMembers(ANY_OTHER_ORG)).rejects.toThrow("Forbidden")
    expect(mockDb.organisation_members.findMany).not.toHaveBeenCalled()
  })

  it("a real id still reaches its own organisation", async () => {
    await revokeInvite(ORG, MEMBER)
    expect(mockDb.organisation_invites.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ org_id: ORG }) })
    )
  })
})

describe("resolveSponsorGrant: the event a grant is for must be one event", () => {
  it("an object event id holds no grant, and asks nothing", async () => {
    const grant = await resolveSponsorGrant({ role: "organizer", orgIds: [ORG] }, ANY_OTHER_ORG)
    expect(grant).toBeNull()
    expect(mockDb.organisations.findFirst).not.toHaveBeenCalled()
  })
})

describe("inside the caller's own organisation, the row id must be one row", () => {
  it("revokeInvite: an object invite id revokes nothing", async () => {
    await expect(revokeInvite(ORG, ANY_OTHER_ORG)).rejects.toThrow("Invite not found")
    expect(mockDb.organisation_invites.updateMany).not.toHaveBeenCalled()
  })

  it("removeDomain: an object domain id deletes nothing", async () => {
    await removeDomain(ORG, ANY_OTHER_ORG)
    expect(mockDb.organisation_domains.deleteMany).not.toHaveBeenCalled()
  })
})
