/*
 * Every dashboard sign-in leaves an audit row: who, from which address
 * (SCRUM-1238, launch gate 10; security audit 2026-11-25 finding 8). Before
 * this nothing answered "who was in, and from where" after an incident.
 *
 * The write is the real `auditLog`, down to the row it hands Prisma; only the
 * database is mocked. It is fire-and-forget, so a slow or failing write can
 * neither hold up nor refuse a sign-in.
 */
import type { NextAuthOptions } from "next-auth"

const mockFindUnique = jest.fn()
const mockAuditCreate = jest.fn()
jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))
jest.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
    organisation_invites: { findFirst: async () => null },
    audit_logs: { create: (...a: unknown[]) => mockAuditCreate(...a) },
  },
}))
jest.mock("bcryptjs", () => ({ compare: async (given: string, stored: string) => given === stored }))

import { authOptions } from "@/lib/auth"
import { logger } from "@/lib/logger"
import { APP_ONLY_SIGNIN } from "@/lib/rbac"

type Authorize = (c: Record<string, string>, req?: { headers: Record<string, string> }) => Promise<unknown>
const rawAuthorize = (
  authOptions as NextAuthOptions & { providers: { options: { authorize: Authorize } }[] }
).providers[0].options.authorize

const PASSWORD = "the-right-one"
// Each call is its own network, so the sign-in limits stay out of it.
let hop = 0
const signIn = (role: string, password = PASSWORD, ip = `203.0.113.${++hop}`) =>
  rawAuthorize({ email: `${role}@x.test`, password }, { headers: { "x-real-ip": ip } })
const account = (role: string, extra: Record<string, unknown> = {}) => ({
  id: `u-${role}`, email: `${role}@x.test`, name: role, role, password: PASSWORD, deletedAt: null, suspended_at: null, ...extra,
})
// auditLog resolves the row's organisation before it writes; let that settle.
const settled = () => new Promise((resolve) => setImmediate(resolve))
const signinRows = () => mockAuditCreate.mock.calls.map(([arg]) => arg.data).filter((row) => row.action === "auth.dashboard_signin")

let warn: jest.SpyInstance
beforeEach(() => {
  mockFindUnique.mockReset()
  mockAuditCreate.mockReset().mockResolvedValue({})
  warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined)
})
afterEach(() => warn.mockRestore())

it.each(["organizer", "venue_owner", "sponsor", "app_admin"])("a %s's sign-in writes exactly one row, with the address it came from", async (role) => {
  mockFindUnique.mockResolvedValue(account(role))
  await expect(signIn(role, PASSWORD, "198.51.100.23")).resolves.toMatchObject({ id: `u-${role}` })
  await settled()
  expect(signinRows()).toEqual([
    {
      user_id: `u-${role}`,
      action: "auth.dashboard_signin",
      resource: "user",
      resource_id: `u-${role}`,
      details: { provider: "credentials" },
      ip_address: "198.51.100.23",
      // A person's sign-in is the platform's to read, never an organisation's.
      org_id: null,
    },
  ])
})

it("warns on an admin's sign-in, so an alert can be set on it, and not on a host's", async () => {
  mockFindUnique.mockResolvedValue(account("app_admin"))
  await signIn("app_admin", PASSWORD, "198.51.100.7")
  expect(warn).toHaveBeenCalledWith("Admin dashboard sign-in", { userId: "u-app_admin", ipAddress: "198.51.100.7" })

  warn.mockClear()
  mockFindUnique.mockResolvedValue(account("organizer"))
  await signIn("organizer")
  expect(warn).not.toHaveBeenCalledWith("Admin dashboard sign-in", expect.anything())
})

it("a wrong password writes nothing", async () => {
  mockFindUnique.mockResolvedValue(account("app_admin"))
  await expect(signIn("app_admin", "wrong")).resolves.toBeNull()
  await settled()
  expect(signinRows()).toEqual([])
  expect(warn).not.toHaveBeenCalledWith("Admin dashboard sign-in", expect.anything())
})

it("a refused sign-in writes nothing: suspended, deleted, or an attendee with no invite", async () => {
  mockFindUnique.mockResolvedValue(account("organizer", { suspended_at: new Date() }))
  await expect(signIn("organizer")).resolves.toBeNull()
  mockFindUnique.mockResolvedValue(account("organizer", { deletedAt: new Date() }))
  await expect(signIn("organizer")).resolves.toBeNull()
  mockFindUnique.mockResolvedValue(account("attendee"))
  await expect(signIn("attendee")).rejects.toThrow(APP_ONLY_SIGNIN)
  await settled()
  expect(signinRows()).toEqual([])
})

it("a write that fails or never answers neither refuses nor holds up the sign-in", async () => {
  mockFindUnique.mockResolvedValue(account("organizer"))
  mockAuditCreate.mockRejectedValueOnce(new Error("database down"))
  await expect(signIn("organizer")).resolves.toMatchObject({ id: "u-organizer" })

  mockAuditCreate.mockReturnValueOnce(new Promise(() => undefined))
  await expect(signIn("organizer")).resolves.toMatchObject({ id: "u-organizer" })
})
