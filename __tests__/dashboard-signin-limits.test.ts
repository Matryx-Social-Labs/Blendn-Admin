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

process.env.NEXTAUTH_SECRET = "test-nextauth-secret-at-least-32-characters"
const mockCookieSet = jest.fn()
jest.mock("next/headers", () => ({ cookies: async () => ({ set: (...a: unknown[]) => mockCookieSet(...a) }) }))

jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))
const mockFindUnique = jest.fn()
jest.mock("@/lib/db", () => ({ db: { user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } } }))
const mockCompare = jest.fn(async (given: string, stored: string) => given === stored)
jest.mock("bcryptjs", () => ({ compare: (...a: [string, string]) => mockCompare(...a) }))

import { authOptions } from "@/lib/auth"
import { clearSigninCounters } from "@/lib/dashboard-signin-limits"
import { knownDeviceCookie } from "@/lib/known-device"
import { SIGNIN_ACCOUNT_LOCKED, SIGNIN_RATE_LIMITED } from "@/lib/rbac"

type Req = { headers: Record<string, string> }
const withCookie = (r: Req, c: { name: string; value: string }): Req => ({ headers: { ...r.headers, cookie: `${c.name}=${c.value}` } })
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
  mockCookieSet.mockReset()
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

/** A network of its own for every call, so only the per-email limits are in play. */
const lone = () => {
  const c = ++n + 1000
  return from(`10.${100 + (c >> 16)}.${(c >> 8) & 255}.${c & 255}`)
}
/** `count` wrong passwords on one email, each from a network of its own. */
async function spray(email: string, count: number) {
  for (let i = 0; i < count; i++) {
    await expect(authorize({ email, password: "wrong" }, lone())).resolves.toBeNull()
  }
}
const asVictim = (email: string) => mockFindUnique.mockResolvedValue(operator(email))

describe("per email, across networks", () => {
  it("stops at 20 wrong passwords in 15 minutes, and refuses the right one from a fresh network", async () => {
    const email = `${fresh("victim")}@x.test`
    asVictim(email)
    await spray(email, 20)
    await expect(authorize({ email, password: PASSWORD }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
  })

  it("lets the right password in below that, from anywhere", async () => {
    const email = `${fresh("below")}@x.test`
    asVictim(email)
    await spray(email, 19)
    await expect(authorize({ email, password: PASSWORD }, lone())).resolves.toMatchObject({ id: "u1" })
  })

  it("is not reset by the victim signing in: the spray goes on counting", async () => {
    const email = `${fresh("noreset")}@x.test`
    asVictim(email)
    await spray(email, 19)
    await expect(authorize({ email, password: PASSWORD }, lone())).resolves.toMatchObject({ id: "u1" })
    await spray(email, 1)
    await expect(authorize({ email, password: PASSWORD }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
  })

  it("holds the cap under concurrency: 30 parallel wrong passwords, at most 20 reach the password check", async () => {
    const email = `${fresh("race")}@x.test`
    asVictim(email)
    mockCompare.mockClear()
    const outcomes = await Promise.allSettled(Array.from({ length: 30 }, () => authorize({ email, password: "wrong" }, lone())))
    expect(mockCompare).toHaveBeenCalledTimes(20)
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(10)
    await expect(authorize({ email, password: PASSWORD }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
  })

  it("also stops at 200 a day, after the 15-minute window has rolled over every time, until a reset", async () => {
    const email = `${fresh("day")}@x.test`
    asVictim(email)
    const realNow = Date.now
    let offset = 0
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + offset)
    try {
      for (let round = 0; round < 10; round++) {
        await spray(email, 19)
        offset += 16 * 60 * 1000
      }
      await spray(email, 9)
      offset += 16 * 60 * 1000
      // 199 wrong passwords today, none in the last 15 minutes: still in.
      await expect(authorize({ email, password: PASSWORD }, lone())).resolves.toMatchObject({ id: "u1" })
      await spray(email, 1)
      offset += 16 * 60 * 1000
      await expect(authorize({ email, password: PASSWORD }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
      // The day's lockout is what a reset must end too.
      await clearSigninCounters(email)
      await expect(authorize({ email, password: PASSWORD }, lone())).resolves.toMatchObject({ id: "u1" })
    } finally {
      jest.restoreAllMocks()
    }
  })

  it("ends at a completed password reset", async () => {
    const email = `${fresh("reset")}@x.test`
    asVictim(email)
    await spray(email, 20)
    await expect(authorize({ email, password: PASSWORD }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
    await clearSigninCounters(email.toUpperCase())
    await expect(authorize({ email, password: PASSWORD }, lone())).resolves.toMatchObject({ id: "u1" })
  })

  it("counts the email case-insensitively and trimmed", async () => {
    const email = `${fresh("case")}@x.test`
    asVictim(email)
    for (let i = 0; i < 20; i++) {
      await authorize({ email: i % 2 ? ` ${email.toUpperCase()} ` : email, password: "wrong" }, lone())
    }
    await expect(authorize({ email, password: PASSWORD }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
  })

  it("is not an oracle: an address with no account hits the same cap", async () => {
    const email = `${fresh("ghost")}@x.test`
    mockFindUnique.mockResolvedValue(null)
    await spray(email, 20)
    await expect(authorize({ email, password: "wrong" }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
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

describe("a known device", () => {
  const locked = async (label: string) => {
    const email = `${fresh(label)}@x.test`
    asVictim(email)
    await spray(email, 20)
    await expect(authorize({ email, password: PASSWORD }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
    return email
  }

  it("is given a signed cookie by a successful sign-in, and by nothing else", async () => {
    const email = `${fresh("issue")}@x.test`
    asVictim(email)
    await authorize({ email, password: "wrong" }, lone())
    expect(mockCookieSet).not.toHaveBeenCalled()
    await authorize({ email, password: PASSWORD }, lone())
    expect(mockCookieSet).toHaveBeenCalledWith(
      expect.stringMatching(/^blendn_kd_/),
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 90 * 24 * 60 * 60 })
    )
  })

  it("signs in while its email is over the per-email cap", async () => {
    const email = `${fresh("known")}@x.test`
    asVictim(email)
    const cookie = knownDeviceCookie(email)!
    await spray(email, 20)
    await expect(authorize({ email, password: PASSWORD }, lone())).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
    await expect(authorize({ email, password: PASSWORD }, withCookie(lone(), cookie))).resolves.toMatchObject({ id: "u1" })
  })

  it("is still held to the network limit", async () => {
    const email = `${fresh("knownnet")}@x.test`
    asVictim(email)
    const cookie = knownDeviceCookie(email)!
    const same = withCookie(lone(), cookie)
    for (let i = 0; i < 5; i++) await authorize({ email, password: "wrong" }, same)
    await expect(authorize({ email, password: PASSWORD }, same)).rejects.toThrow(SIGNIN_RATE_LIMITED)
  })

  it("does not let another email's cookie, a forged one, or an expired one past the cap", async () => {
    const email = await locked("forge")
    const other = knownDeviceCookie(`${fresh("other")}@x.test`)!
    // The right name for this email, someone else's proof.
    const nameForEmail = knownDeviceCookie(email)!.name
    const forged = { name: nameForEmail, value: `${Date.now()}.${"A".repeat(43)}` }
    const swapped = { name: nameForEmail, value: other.value }
    const stale = knownDeviceCookie(email, Date.now() - 91 * 24 * 60 * 60 * 1000)!
    const future = knownDeviceCookie(email, Date.now() + 60 * 60 * 1000)!
    for (const c of [other, forged, swapped, stale, future]) {
      await expect(authorize({ email, password: PASSWORD }, withCookie(lone(), c))).rejects.toThrow(SIGNIN_ACCOUNT_LOCKED)
    }
  })
})

it("refuses an email longer than 254 characters before it becomes a limiter key", async () => {
  mockFindUnique.mockResolvedValue(null)
  await expect(authorize({ email: `${"a".repeat(250)}@x.test`, password: "x" }, lone())).resolves.toBeNull()
  expect(mockFindUnique).not.toHaveBeenCalled()
})
