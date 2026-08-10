process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * Suspension has to mean something on the phone.
 *
 * `users.suspended_at` and `suspended_by` shipped with the venues migration and
 * were read in exactly one place — `socket-ops-auth.ts`, which guards the
 * organiser ops socket. Suspending an attendee therefore stopped them opening a
 * dashboard they never had, and changed nothing about the app they were
 * actually in. That made "Suspend" the only real lever in a moderation queue,
 * and a lever attached to nothing.
 *
 * These tests are the reason the reports queue can offer the button.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  user: { findUnique: jest.fn() },
  mobile_refresh_tokens: { create: jest.fn().mockResolvedValue({}) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  createAuthRateLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))

jest.mock("@/lib/location", () => ({
  normalizeLocationToCity: jest.fn().mockResolvedValue(null),
}))

import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"
import { accountBlockReason } from "@/lib/mobile-auth"
import { POST as signin } from "@/app/api/mobile/auth/signin/route"

describe("accountBlockReason", () => {
  const live = { deletedAt: null, suspended_at: null }

  it("lets a live account through", () => {
    expect(accountBlockReason(live)).toBeNull()
  })

  it("blocks a suspended account", () => {
    expect(accountBlockReason({ ...live, suspended_at: new Date() })).toBe("suspended")
  })

  it("blocks a deleted account", () => {
    expect(accountBlockReason({ ...live, deletedAt: new Date() })).toBe("deleted")
  })

  it("treats a missing row as deleted rather than as fine", () => {
    // Fails closed. The alternative reading — "no row, no reason to block" —
    // is how a null from a bad id becomes a session.
    expect(accountBlockReason(null)).toBe("deleted")
  })

  it("reports deletion ahead of suspension when both are set", () => {
    // A deleted account must never be told it is suspended: that confirms the
    // address exists to whoever is asking.
    expect(accountBlockReason({ deletedAt: new Date(), suspended_at: new Date() })).toBe("deleted")
  })
})

describe("POST /auth/signin — a suspended account", () => {
  const PASSWORD = "correct horse battery staple"
  let hash: string

  beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4)
  })

  beforeEach(() => jest.clearAllMocks())

  const req = (password: string) =>
    new NextRequest("https://api.blendn.app/api/mobile/auth/signin", {
      method: "POST",
      body: JSON.stringify({ email: "a@b.com", password }),
      headers: { "content-type": "application/json" },
    })

  const user = (over: Partial<{ suspended_at: Date | null; deletedAt: Date | null }> = {}) => ({
    id: "u1",
    email: "a@b.com",
    name: "A",
    password: hash,
    deletedAt: null,
    suspended_at: null,
    profile: null,
    ...over,
  })

  it("is refused with a reason it can act on", async () => {
    mockDb.user.findUnique.mockResolvedValue(user({ suspended_at: new Date() }))
    const res = await signin(req(PASSWORD))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/suspended/i)
  })

  it("gets no token", async () => {
    mockDb.user.findUnique.mockResolvedValue(user({ suspended_at: new Date() }))
    const body = await (await signin(req(PASSWORD))).json()
    expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken/)
    expect(mockDb.mobile_refresh_tokens.create).not.toHaveBeenCalled()
  })

  it("is checked after the password, not before", async () => {
    /*
     * The ordering that keeps this from becoming an oracle. If suspension were
     * checked first, anyone could learn which addresses are suspended without
     * knowing a password — and "suspended" is a fact about a person, not a
     * public property of an email address.
     */
    mockDb.user.findUnique.mockResolvedValue(user({ suspended_at: new Date() }))
    const res = await signin(req("wrong password entirely"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).not.toMatch(/suspended/i)
  })

  it("still signs in a live account", async () => {
    mockDb.user.findUnique.mockResolvedValue(user())
    expect((await signin(req(PASSWORD))).status).toBe(200)
  })
})
