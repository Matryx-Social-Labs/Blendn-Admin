/*
 * An attendee who signs in to the dashboard is told why, and gets no session
 * (SCRUM-172).
 *
 * Driven on staging: kavya.n@ (attendee, right password) signed in at /login,
 * `authorize` returned her, NextAuth set a dashboard cookie, the middleware
 * bounced /dashboard back to /login, and the form reappeared with nothing on
 * it. She typed the password again until the sign-in limit told her "too many
 * attempts" for a password that was right every time. Reproduced 2026-09-25
 * with a fresh attendee in SCRUM-235.
 */
import type { NextAuthOptions } from "next-auth"

jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))
const mockFindUnique = jest.fn()
const mockInvite = jest.fn()
jest.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
    organisation_invites: { findFirst: (...a: unknown[]) => mockInvite(...a) },
  },
}))
jest.mock("bcryptjs", () => ({ compare: async (given: string, stored: string) => given === stored }))

import { authOptions } from "@/lib/auth"
import { APP_ONLY_SIGNIN } from "@/lib/rbac"

type Authorize = (c: Record<string, string>, req?: { headers: Record<string, string> }) => Promise<unknown>
const rawAuthorize = (
  authOptions as NextAuthOptions & { providers: { options: { authorize: Authorize } }[] }
).providers[0].options.authorize
// Each call is its own network: the sign-in limits are not what this file is about.
let hop = 0
const authorize = (c: Record<string, string>) => rawAuthorize(c, { headers: { "x-real-ip": `10.0.0.${++hop}` } })

const PASSWORD = "the-right-one"
function account(role: string, extra: Record<string, unknown> = {}) {
  return { id: `u-${role}`, email: `${role}@x.test`, name: role, role, password: PASSWORD, deletedAt: null, suspended_at: null, ...extra }
}

beforeEach(() => mockFindUnique.mockReset())

it("refuses an attendee with the right password by name, so the form can say why", async () => {
  mockFindUnique.mockResolvedValue(account("attendee"))
  await expect(authorize({ email: "attendee@x.test", password: PASSWORD })).rejects.toThrow(APP_ONLY_SIGNIN)
})

it("says nothing about the role to a wrong password", async () => {
  mockFindUnique.mockResolvedValue(account("attendee"))
  await expect(authorize({ email: "attendee@x.test", password: "wrong" })).resolves.toBeNull()
})

it("says nothing about the role to a suspended attendee, whose refusal stays generic", async () => {
  mockFindUnique.mockResolvedValue(account("attendee", { suspended_at: new Date() }))
  await expect(authorize({ email: "attendee@x.test", password: PASSWORD })).resolves.toBeNull()
})

it.each(["app_admin", "organizer", "venue_owner", "sponsor"])("still signs in a %s", async (role) => {
  mockFindUnique.mockResolvedValue(account(role))
  await expect(authorize({ email: `${role}@x.test`, password: PASSWORD })).resolves.toMatchObject({ id: `u-${role}`, role })
})

// An invite is how an attendee becomes a host, and accepting one needs a session (found driving SCRUM-942).
it("lets an attendee with a live invite sign in, to accept it", async () => {
  mockFindUnique.mockResolvedValue({ id: "u-attendee", email: "attendee@x.test", name: "A", password: PASSWORD, role: "attendee" })
  mockInvite.mockResolvedValueOnce({ id: "i1" })
  await expect(authorize({ email: "attendee@x.test", password: PASSWORD })).resolves.toMatchObject({ id: "u-attendee", role: "attendee" })
  const where = mockInvite.mock.calls.at(-1)?.[0].where
  expect(where).toMatchObject({ email: "attendee@x.test", accepted_at: null, revoked_at: null, org: { status: { not: "suspended" } } })
  expect(where.expires_at.gt).toBeInstanceOf(Date)
})

it("still refuses an attendee whose invite is gone, and never asks before the password", async () => {
  mockFindUnique.mockResolvedValue({ id: "u-attendee", email: "attendee@x.test", name: "A", password: PASSWORD, role: "attendee" })
  mockInvite.mockReset()
  mockInvite.mockResolvedValue(null)
  await expect(authorize({ email: "attendee@x.test", password: PASSWORD })).rejects.toThrow(APP_ONLY_SIGNIN)
  mockInvite.mockReset()
  await expect(authorize({ email: "attendee@x.test", password: "wrong" })).resolves.toBeNull()
  expect(mockInvite).not.toHaveBeenCalled()
})
