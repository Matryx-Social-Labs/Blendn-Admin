/*
 * The dashboard sign-in limits live in authorize(), the one place every path
 * to a password check reaches (security audit 2026-10-24, WEB H1 / M5 / L1).
 *
 * The limit used to match the raw request path, and `/api/auth/callback/%63redentials`
 * (same catch-all route, segment decoded by Next) walked around it: unlimited
 * bcrypt guesses. It was per-IP only, so many addresses were unlimited too. And
 * an unknown email returned before bcrypt, so the response time named the
 * accounts that exist.
 */
import type { NextAuthOptions } from "next-auth"

jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))
const mockFindUnique = jest.fn()
jest.mock("@/lib/db", () => ({ db: { user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } } }))
const mockCompare = jest.fn(async (given: string, stored: string) => given === stored)
jest.mock("bcryptjs", () => ({ compare: (...a: [string, string]) => mockCompare(...a) }))

import { authOptions } from "@/lib/auth"
import { SIGNIN_RATE_LIMITED } from "@/lib/rbac"

type Req = { headers: Record<string, string> }
type Authorize = (c: Record<string, string>, req?: Req) => Promise<unknown>
const authorize = (
  authOptions as NextAuthOptions & { providers: { options: { authorize: Authorize } }[] }
).providers[0].options.authorize

// What real accounts hold, so the comparison costs what a real one costs.
const COST_12_HASH = /^\$2[aby]\$12\$.{53}$/
const PASSWORD = "the-right-one"
const run = Math.random().toString(36).slice(2)
let n = 0
const fresh = (label: string) => `${label}-${run}-${++n}`
const from = (ip: string): Req => ({ headers: { "x-real-ip": ip } })
const operator = (email: string) => ({
  id: "u1", email, name: "Op", role: "organizer", password: PASSWORD, deletedAt: null, suspended_at: null,
})

beforeEach(() => {
  mockFindUnique.mockReset()
  mockCompare.mockClear()
})

describe("per network", () => {
  it("refuses the sixth attempt from one address, right password or not", async () => {
    const ip = `10.1.0.${++n}`
    mockFindUnique.mockResolvedValue(null)
    for (let i = 0; i < 5; i++) {
      await expect(authorize({ email: `${fresh("a")}@x.test`, password: "wrong" }, from(ip))).resolves.toBeNull()
    }
    mockFindUnique.mockResolvedValue(operator("o@x.test"))
    await expect(authorize({ email: `${fresh("b")}@x.test`, password: PASSWORD }, from(ip))).rejects.toThrow(SIGNIN_RATE_LIMITED)
  })
})

/** `count` wrong passwords on one email, each from a network of its own. */
async function spray(email: string, count: number) {
  for (let i = 0; i < count; i++) {
    await expect(authorize({ email, password: "wrong" }, from(`10.${100 + (n % 100)}.${Math.floor(n / 250)}.${++n % 250}`))).resolves.toBeNull()
  }
}

describe("per account, across networks", () => {
  it("refuses the 51st wrong password on one email, even the right one, from a fresh network", async () => {
    const email = `${fresh("victim")}@x.test`
    mockFindUnique.mockResolvedValue(operator(email))
    await spray(email, 50)
    await expect(authorize({ email, password: PASSWORD }, from(`10.3.0.${++n}`))).rejects.toThrow(SIGNIN_RATE_LIMITED)
  })

  it("does not lock the victim out of their own network below that ceiling", async () => {
    const email = `${fresh("below")}@x.test`
    mockFindUnique.mockResolvedValue(operator(email))
    await spray(email, 40)
    await expect(authorize({ email, password: PASSWORD }, from(`10.3.1.${++n}`))).resolves.toMatchObject({ id: "u1" })
  })

  it("clears the account's count on a correct password", async () => {
    const email = `${fresh("clears")}@x.test`
    mockFindUnique.mockResolvedValue(operator(email))
    await spray(email, 49)
    await expect(authorize({ email, password: PASSWORD }, from(`10.3.2.${++n}`))).resolves.toMatchObject({ id: "u1" })
    // Without the clear, the next guess is the 51st.
    await spray(email, 49)
    await expect(authorize({ email, password: PASSWORD }, from(`10.3.3.${++n}`))).resolves.toMatchObject({ id: "u1" })
  })

  it("counts the email case-insensitively and trimmed", async () => {
    const email = `${fresh("case")}@x.test`
    mockFindUnique.mockResolvedValue(operator(email))
    for (let i = 0; i < 50; i++) {
      await authorize({ email: i % 2 ? ` ${email.toUpperCase()} ` : email, password: "wrong" }, from(`10.4.${n}.${++n % 250}`))
    }
    await expect(authorize({ email, password: PASSWORD }, from(`10.5.0.${++n}`))).rejects.toThrow(SIGNIN_RATE_LIMITED)
  })

  it("is not an oracle: an address with no account hits the same cap", async () => {
    const email = `${fresh("ghost")}@x.test`
    mockFindUnique.mockResolvedValue(null)
    await spray(email, 50)
    await expect(authorize({ email, password: "wrong" }, from(`10.7.0.${++n}`))).rejects.toThrow(SIGNIN_RATE_LIMITED)
  })
})

describe("the network is the /64 for IPv6", () => {
  it("shares one bucket across addresses inside a /64", async () => {
    mockFindUnique.mockResolvedValue(null)
    const prefix = `2001:db8:a:${(++n + 4096).toString(16)}`
    for (let i = 0; i < 5; i++) {
      await authorize({ email: `${fresh("v6")}@x.test`, password: "wrong" }, from(`${prefix}::${i + 1}`))
    }
    await expect(authorize({ email: `${fresh("v6")}@x.test`, password: "wrong" }, from(`${prefix}:ffff:1:2:3`))).rejects.toThrow(SIGNIN_RATE_LIMITED)
  })
})

describe("timing", () => {
  it("pays for a password comparison when the account does not exist", async () => {
    mockFindUnique.mockResolvedValue(null)
    await expect(authorize({ email: `${fresh("nobody")}@x.test`, password: "x" }, from(`10.8.0.${++n}`))).resolves.toBeNull()
    expect(mockCompare).toHaveBeenCalledTimes(1)
    expect(mockCompare).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(COST_12_HASH))
  })

  it("pays for it when the account has no password (OAuth-only)", async () => {
    mockFindUnique.mockResolvedValue({ ...operator("o@x.test"), password: null })
    await expect(authorize({ email: `${fresh("oauth")}@x.test`, password: "x" }, from(`10.9.0.${++n}`))).resolves.toBeNull()
    expect(mockCompare).toHaveBeenCalledTimes(1)
    expect(mockCompare).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(COST_12_HASH))
  })
})
