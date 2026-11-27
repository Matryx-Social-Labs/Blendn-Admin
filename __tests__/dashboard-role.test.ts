/*
 * Dashboard entry comes from organisation membership, not `User.role` (SCRUM-1247; security audit 2026-11-25 finding 5).
 *
 * The session's `role` claim is what the middleware, the nav, `mayReachRoute` and every `canAccessDashboard(session.role)`
 * read. It is now derived on every session read, in the one statement that read already was: `app_admin` if the row is,
 * otherwise the kind of the home organisation (oldest live membership), otherwise `attendee`. Task 11 can then stop
 * writing `User.role` without locking a host out of the dashboard. The SQL itself is proved against Postgres in
 * `integration/dashboard-role-from-membership.itest.ts`; this file pins what each reader does with its answer.
 */
import type { NextAuthOptions } from "next-auth"

jest.mock("next-auth", () => ({ ...jest.requireActual("next-auth"), getServerSession: (...a: unknown[]) => mockServerSession(...a) }))
jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))
const mockServerSession = jest.fn()
const mockRaw = jest.fn()
const mockFindUnique = jest.fn()
const mockInvite = jest.fn()
const mockMembers = jest.fn()
jest.mock("@/lib/db", () => ({
  db: {
    $queryRaw: (...a: unknown[]) => mockRaw(...a),
    user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
    organisation_invites: { findFirst: (...a: unknown[]) => mockInvite(...a) },
    organisation_members: { findMany: (...a: unknown[]) => mockMembers(...a), findFirst: (...a: unknown[]) => mockMembers(...a) },
    audit_logs: { create: () => Promise.resolve({}) },
  },
}))
jest.mock("bcryptjs", () => ({ compare: async (given: string, stored: string) => given === stored }))

import { authOptions } from "@/lib/auth"
import { currentUser } from "@/lib/current-user"
import { dashboardRoleFor, sessionAccount } from "@/lib/org-membership"
import { APP_ONLY_SIGNIN } from "@/lib/rbac"
import { SessionEnded } from "@/lib/session-revocation"

describe("dashboardRoleFor", () => {
  it.each(["organizer", "venue_owner", "sponsor"])("an attendee-role member whose home org is of kind %s gets it", (kind) => {
    expect(dashboardRoleFor({ role: "attendee", home_kind: kind })).toBe(kind)
  })

  it("follows the home org, whatever the row says", () => {
    expect(dashboardRoleFor({ role: "venue_owner", home_kind: "organizer" })).toBe("organizer")
    expect(dashboardRoleFor({ role: "organizer", home_kind: "venue_owner" })).toBe("venue_owner")
  })

  it("is attendee with no live membership, a dashboard role on the row notwithstanding", () => {
    for (const role of ["attendee", "organizer", "venue_owner", "sponsor"] as const) {
      expect(dashboardRoleFor({ role, home_kind: null })).toBe("attendee")
    }
  })

  it("keeps an app_admin an app_admin whatever their memberships", () => {
    expect(dashboardRoleFor({ role: "app_admin", home_kind: null })).toBe("app_admin")
    expect(dashboardRoleFor({ role: "app_admin", home_kind: "venue_owner" })).toBe("app_admin")
  })

  it("refuses a kind it does not know rather than pass it into a session", () => {
    expect(() => dashboardRoleFor({ role: "attendee", home_kind: "app_admin" })).toThrow()
    expect(() => dashboardRoleFor({ role: "attendee", home_kind: "owner" })).toThrow()
  })
})

const row = (role: string, home_kind: string | null, extra: Record<string, unknown> = {}) => ({
  id: "u-1", email: "a@x.test", name: "A", role, home_kind,
  suspended_at: null, deletedAt: null, password_changed_at: null, sessions_revoked_at: null, ...extra,
})

beforeEach(() => {
  mockRaw.mockReset()
  mockFindUnique.mockReset()
  mockInvite.mockReset()
  mockMembers.mockReset()
})

describe("sessionAccount", () => {
  it("is one statement, keyed by the id, and carries both the row's role and the dashboard's", async () => {
    mockRaw.mockResolvedValue([row("attendee", "organizer")])
    await expect(sessionAccount("u-1")).resolves.toMatchObject({ id: "u-1", role: "attendee", dashboardRole: "organizer" })
    expect(mockRaw).toHaveBeenCalledTimes(1)
    expect(mockRaw.mock.calls[0].slice(1)).toContain("u-1")
  })

  it("is null with no row, and throws on a role the enum does not have", async () => {
    mockRaw.mockResolvedValue([])
    await expect(sessionAccount("u-1")).resolves.toBeNull()
    mockRaw.mockResolvedValue([row("superuser", null)])
    await expect(sessionAccount("u-1")).rejects.toThrow()
  })
})

const callbacks = authOptions.callbacks as unknown as { jwt: (a: { token: Record<string, unknown> }) => Promise<Record<string, unknown>> }

describe("every session read derives the role, in the one statement it already was", () => {
  const token = { sub: "u-1", role: "attendee", signedInAt: Date.now() }

  it("an attendee-role row with one live organizer-org membership is an organizer session", async () => {
    mockRaw.mockResolvedValue([row("attendee", "organizer")])
    await expect(callbacks.jwt({ token })).resolves.toMatchObject({ role: "organizer", inviteOnly: false })
    expect(mockRaw).toHaveBeenCalledTimes(1)
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockMembers).not.toHaveBeenCalled()
    expect(mockInvite).not.toHaveBeenCalled()
  })

  it("a dashboard-role row with no live membership and no invite ends", async () => {
    mockRaw.mockResolvedValue([row("organizer", null)])
    mockInvite.mockResolvedValue(null)
    await expect(callbacks.jwt({ token: { ...token, role: "organizer" } })).rejects.toThrow(SessionEnded)
  })

  it("with none but a live invite, is the invite's session, as today", async () => {
    mockRaw.mockResolvedValue([row("attendee", null)])
    mockInvite.mockResolvedValue({ id: "i1" })
    await expect(callbacks.jwt({ token })).resolves.toMatchObject({ role: "attendee", inviteOnly: true })
  })

  it("an app_admin stays app_admin with a venue org's membership, and keeps the 12-hour rule", async () => {
    mockRaw.mockResolvedValue([row("app_admin", "venue_owner")])
    await expect(callbacks.jwt({ token: { ...token, role: "app_admin" } })).resolves.toMatchObject({ role: "app_admin", inviteOnly: false })
    await expect(callbacks.jwt({ token: { ...token, role: "app_admin", signedInAt: Date.now() - 13 * 3_600_000 } })).rejects.toThrow(SessionEnded)
  })

  it("a suspended user ends, memberships or not", async () => {
    mockRaw.mockResolvedValue([row("attendee", "organizer", { suspended_at: new Date() })])
    await expect(callbacks.jwt({ token })).rejects.toThrow(SessionEnded)
  })
})

describe("sign-in uses the derived role", () => {
  type Authorize = (c: Record<string, string>, req?: { headers: Record<string, string> }) => Promise<unknown>
  const rawAuthorize = (authOptions as NextAuthOptions & { providers: { options: { authorize: Authorize } }[] }).providers[0].options.authorize
  let hop = 0
  const signIn = () => rawAuthorize({ email: "a@x.test", password: "pw" }, { headers: { "x-real-ip": `10.9.0.${++hop}` } })

  it("an attendee-role member of a venue org signs in as venue_owner, with no invite asked for", async () => {
    mockRaw.mockResolvedValue([row("attendee", "venue_owner", { password: "pw" })])
    await expect(signIn()).resolves.toMatchObject({ id: "u-1", role: "venue_owner" })
    expect(mockRaw.mock.calls[0].slice(1)).toContain("a@x.test")
    expect(mockInvite).not.toHaveBeenCalled()
  })

  it("an organizer-role row with no live membership and no invite is refused as app-only", async () => {
    mockRaw.mockResolvedValue([row("organizer", null, { password: "pw" })])
    mockInvite.mockResolvedValue(null)
    await expect(signIn()).rejects.toThrow(APP_ONLY_SIGNIN)
  })
})

describe("currentUser authorises on the same derived role", () => {
  it("an attendee-role member of a brand org is a sponsor to every action", async () => {
    mockServerSession.mockResolvedValue({ user: { id: "u-1", role: "sponsor", signedInAt: Date.now(), inviteOnly: false } })
    mockRaw.mockResolvedValue([row("attendee", "sponsor")])
    await expect(currentUser()).resolves.toEqual({ id: "u-1", role: "sponsor" })
  })
})
