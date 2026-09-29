/**
 * The dashboard socket gate re-reads the account on every connection.
 *
 * It refused a suspended account and nothing else, so an erased account whose
 * dashboard cookie was still live reconnected straight after deletion evicted
 * it (SCRUM-449, security review): the mobile gate and the NextAuth `jwt`
 * callback both check `deletedAt`, this one did not.
 */
const mockDecode = jest.fn()
jest.mock("next-auth/jwt", () => ({ decode: (...a: unknown[]) => mockDecode(...a) }))
const mockFindUnique = jest.fn()
jest.mock("@/lib/db", () => ({ db: { user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } } }))
jest.mock("@/lib/logger", () => ({ logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() } }))
jest.mock("@/lib/rbac", () => ({ eventPermissions: jest.fn() }))
jest.mock("@/lib/org-membership", () => ({ actorFor: jest.fn() }))

import { authenticateDashboardSocket } from "@/lib/socket-ops-auth"

const COOKIE = "next-auth.session-token=signed-session"
const live = { id: "u1", email: "host@example.com", role: "organizer", suspended_at: null, deletedAt: null }

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-at-least-32-characters-long"
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDecode.mockResolvedValue({ sub: "u1" })
})

it("lets a live dashboard account through, with the role read from the row", async () => {
  mockFindUnique.mockResolvedValue(live)
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toEqual({
    userId: "u1",
    email: "host@example.com",
    role: "organizer",
  })
  expect(mockFindUnique).toHaveBeenCalledWith(
    expect.objectContaining({ select: expect.objectContaining({ deletedAt: true, suspended_at: true }) })
  )
})

it("refuses a deleted account whose cookie is still live", async () => {
  mockFindUnique.mockResolvedValue({ ...live, deletedAt: new Date() })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toBeNull()
})

it("refuses a suspended account", async () => {
  mockFindUnique.mockResolvedValue({ ...live, suspended_at: new Date() })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toBeNull()
})
