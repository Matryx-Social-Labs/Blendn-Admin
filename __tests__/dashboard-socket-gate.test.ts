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
jest.mock("@/lib/rbac", () => ({ eventPermissions: jest.fn(), canAccessDashboard: (role: string) => role !== "attendee" }))
jest.mock("@/lib/org-membership", () => ({ actorFor: jest.fn(), sessionAccount: () => mockSessionAccount(mockFindUnique()) }))

import { authenticateDashboardSocket } from "@/lib/socket-ops-auth"
import { mockSessionAccount } from "./support/session-account"

const COOKIE = "next-auth.session-token=signed-session"
const SIGNED_IN = Date.parse("2026-10-01T10:00:00Z")
const live = { id: "u1", email: "host@example.com", role: "organizer", suspended_at: null, deletedAt: null, password_changed_at: null, sessions_revoked_at: null }

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-at-least-32-characters-long"
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDecode.mockResolvedValue({ sub: "u1", signedInAt: SIGNED_IN })
})

it("lets a live dashboard account through, with the role read from the row", async () => {
  mockFindUnique.mockResolvedValue(live)
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toEqual({
    userId: "u1",
    email: "host@example.com",
    role: "organizer",
  })
  // The one statement the pages' session read is too (`sessionAccount`, SCRUM-1247).
  expect(mockFindUnique).toHaveBeenCalledTimes(1)
})

// SCRUM-1247: the role is the home organisation's kind, whatever the row says.
it("lets in an attendee-role member of a live venue org as venue_owner, and refuses a dashboard-role row with none", async () => {
  mockFindUnique.mockResolvedValue({ ...live, role: "attendee", home_kind: "venue_owner" })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toEqual({ userId: "u1", email: "host@example.com", role: "venue_owner" })
  mockFindUnique.mockResolvedValue({ ...live, role: "organizer", home_kind: null })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toBeNull()
})

it("refuses a deleted account whose cookie is still live", async () => {
  mockFindUnique.mockResolvedValue({ ...live, deletedAt: new Date() })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toBeNull()
})

it("refuses a suspended account", async () => {
  mockFindUnique.mockResolvedValue({ ...live, suspended_at: new Date() })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toBeNull()
})

/*
 * The pages' rule, at the handshake too (step 18 security review, M6): a
 * cookie from before the password changed is somebody the owner locked out.
 * The handshake gets the raw cookie, never re-minted, so a session from before
 * `signedInAt` existed is judged by its iat.
 */
it("refuses a session that signed in before the password changed", async () => {
  mockFindUnique.mockResolvedValue({ ...live, password_changed_at: new Date(SIGNED_IN + 1_000) })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toBeNull()
  mockDecode.mockResolvedValue({ sub: "u1", iat: SIGNED_IN / 1000 })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toBeNull()
})

it("lets in a session that signed in after it", async () => {
  mockFindUnique.mockResolvedValue({ ...live, password_changed_at: new Date(SIGNED_IN - 1_000) })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toMatchObject({ userId: "u1" })
})

it("refuses a session held only to accept an invite (SCRUM-984)", async () => {
  mockFindUnique.mockResolvedValue({ ...live, role: "attendee" })
  await expect(authenticateDashboardSocket(COOKIE)).resolves.toBeNull()
})
