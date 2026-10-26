/*
 * The mobile sign-in route is a second door onto the same passwords (security
 * review of fix/security-auth, M1): it verified a staff account's password and
 * answered 403 ACCOUNT_STAFF only when it was right, under limits of its own, so
 * it was a password oracle that stepped around the dashboard's per-email caps;
 * and it skipped bcrypt for an unknown email, so its timing named the accounts.
 */
process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"
process.env.NEXTAUTH_SECRET = "test-nextauth-secret-at-least-32-characters"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))
jest.mock("next/headers", () => ({ cookies: async () => ({ set: jest.fn() }) }))
const mockFindUnique = jest.fn()
jest.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
    mobile_refresh_tokens: { create: jest.fn() },
  },
}))
const mockCompare = jest.fn(async (given: string, stored: string) => given === stored)
jest.mock("bcryptjs", () => ({ ...jest.requireActual("bcryptjs"), compare: (...a: [string, string]) => mockCompare(...a) }))

import { NextRequest } from "next/server"
import type { NextAuthOptions } from "next-auth"

import { authOptions } from "@/lib/auth"
import { SIGNIN_ACCOUNT_LOCKED } from "@/lib/rbac"
import { POST } from "@/app/api/mobile/auth/signin/route"

type Authorize = (c: Record<string, string>, req?: { headers: Record<string, string> }) => Promise<unknown>
const authorize = (authOptions as NextAuthOptions & { providers: { options: { authorize: Authorize } }[] }).providers[0].options.authorize

const PASSWORD = "the-right-one"
const run = Math.random().toString(36).slice(2)
let n = 0
const lone = () => {
  const c = ++n + 5000
  return `10.${50 + (c >> 16)}.${(c >> 8) & 255}.${c & 255}`
}
const staff = (email: string) => ({ id: "s1", email, name: "S", role: "organizer", password: PASSWORD, deletedAt: null, suspended_at: null, profile: null })
const mobile = (email: string, password: string) =>
  POST(
    new NextRequest("http://localhost/api/mobile/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": lone() },
      body: JSON.stringify({ email, password }),
    })
  )

beforeEach(() => {
  mockFindUnique.mockReset()
  mockCompare.mockClear()
})

it("refuses a staff account's right password once the email is over its per-email cap, instead of confirming it with a 403", async () => {
  const email = `staff-${run}-1@x.test`
  mockFindUnique.mockResolvedValue(staff(email))
  for (let i = 0; i < 20; i++) await authorize({ email, password: "wrong" }, { headers: { "x-real-ip": lone() } })
  const res = await mobile(email, PASSWORD)
  expect(res.status).toBe(429)
})

it("counts the mobile route's wrong passwords against the same email as the dashboard's", async () => {
  const email = `staff-${run}-2@x.test`
  mockFindUnique.mockResolvedValue(staff(email))
  for (let i = 0; i < 10; i++) expect((await mobile(email, "wrong")).status).toBe(401)
  for (let i = 0; i < 10; i++) await authorize({ email, password: "wrong" }, { headers: { "x-real-ip": lone() } })
  await expect(authorize({ email, password: PASSWORD }, { headers: { "x-real-ip": lone() } })).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
})

it("still tells a staff account's owner, with the right password under the cap, that the app is not for them", async () => {
  const email = `staff-${run}-3@x.test`
  mockFindUnique.mockResolvedValue(staff(email))
  expect((await mobile(email, PASSWORD)).status).toBe(403)
})

it("pays for a password comparison when the email has no account", async () => {
  mockFindUnique.mockResolvedValue(null)
  expect((await mobile(`ghost-${run}@x.test`, "x")).status).toBe(401)
  expect(mockCompare).toHaveBeenCalledTimes(1)
  expect(mockCompare).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^\$2[aby]\$12\$.{53}$/))
})

it("refuses an email longer than 254 characters before it becomes a limiter key", async () => {
  const res = await mobile(`${"a".repeat(250)}@x.test`, "x")
  expect(res.status).toBe(400)
  expect(mockFindUnique).not.toHaveBeenCalled()
})
