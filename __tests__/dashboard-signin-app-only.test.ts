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
jest.mock("@/lib/db", () => ({ db: { user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } } }))
jest.mock("bcryptjs", () => ({ compare: async (given: string, stored: string) => given === stored }))

import { authOptions } from "@/lib/auth"
import { APP_ONLY_SIGNIN } from "@/lib/rbac"

type Authorize = (c: Record<string, string>) => Promise<unknown>
const authorize = (
  authOptions as NextAuthOptions & { providers: { options: { authorize: Authorize } }[] }
).providers[0].options.authorize

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
