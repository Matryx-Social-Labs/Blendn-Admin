process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * The first route-handler test in this repo.
 *
 * `mobile-auth.test.ts` covers the token primitives well, but nothing has ever
 * imported anything under `app/api/mobile/auth/`. That gap is why a route could
 * accept an 8-character password while the reset route demanded 12 for months
 * without a single test going red.
 *
 * Same mocking shape as `mobile-auth.test.ts`: env before imports, `jose`
 * stubbed because it is ESM-only and ts-jest cannot transform it, and `@/lib/db`
 * replaced with a hand-rolled object.
 */
jest.mock("jose", () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
}))

const mockDb = {
  user: { findUnique: jest.fn(), create: jest.fn() },
  profiles: { create: jest.fn() },
  mobile_refresh_tokens: { create: jest.fn() },
  $transaction: jest.fn(),
}

jest.mock("@/lib/db", () => ({ db: mockDb }))

// Rate limiting is Redis-backed; `null` means "allowed" in this codebase.
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  createAuthRateLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))

// Reverse geocoding would make a network call; the value is irrelevant here.
jest.mock("@/lib/location", () => ({
  normalizeLocationToCity: jest.fn().mockResolvedValue(null),
}))

import { NextRequest } from "next/server"
import { POST } from "@/app/api/mobile/auth/signup/route"

const VALID = "correct horse battery staple"

function req(body: unknown) {
  return new NextRequest("https://api.blendn.app/api/mobile/auth/signup", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.user.findUnique.mockResolvedValue(null)
  mockDb.user.create.mockResolvedValue({ id: "u1", email: "a@b.com", name: "A" })
  mockDb.profiles.create.mockResolvedValue({ id: "u1", name: "A", onboarded: false, location: null })
  mockDb.mobile_refresh_tokens.create.mockResolvedValue({})
  // Run the callback against the same mock, so the transaction is transparent.
  mockDb.$transaction.mockImplementation((fn: (tx: typeof mockDb) => unknown) => fn(mockDb))
})

describe("POST /api/mobile/auth/signup — password rules", () => {
  it("rejects a password under the shared minimum", async () => {
    const res = await POST(req({ email: "a@b.com", password: "Short1!aa", name: "A" }))
    expect(res.status).toBe(400)
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it("rejects an obvious password that is long enough to pass a length check", async () => {
    /*
     * The assertion that proves `checkPassword` is wired, not just zod's
     * `.min()`. `password1234` is twelve characters — it satisfies the length
     * rule and nothing else, and it is exactly how a length rule gets defeated.
     */
    const res = await POST(req({ email: "a@b.com", password: "password1234", name: "A" }))
    expect(res.status).toBe(400)
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it("rejects a password built from the local part of the address", async () => {
    const res = await POST(req({ email: "jonathan@b.com", password: "jonathan-9182", name: "J" }))
    expect(res.status).toBe(400)
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it("accepts a long passphrase", async () => {
    const res = await POST(req({ email: "a@b.com", password: VALID, name: "A" }))
    expect(res.status).toBe(201)
  })
})

describe("POST /api/mobile/auth/signup — name and age", () => {
  it("refuses a signup with no name", async () => {
    // The app has always required it; the server permitting it was the only
    // path producing an account the moderation queue can identify by nothing
    // but an email address.
    const res = await POST(req({ email: "a@b.com", password: VALID }))
    expect(res.status).toBe(400)
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it("still accepts a signup with no age", async () => {
    /*
     * The guarantee that keeps this deployable.
     *
     * The shipped app does not send `age` yet, and the server reaches staging
     * before an app build does. If this ever starts failing, every new password
     * signup in production is 400ing — make `age` required only in the release
     * after the app ships the field.
     */
    const res = await POST(req({ email: "a@b.com", password: VALID, name: "A" }))
    expect(res.status).toBe(201)
  })

  it("rejects an age below the floor", async () => {
    const res = await POST(req({ email: "a@b.com", password: VALID, name: "A", age: 11 }))
    expect(res.status).toBe(400)
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it("stores the age on the profile when sent", async () => {
    // There is nowhere else it can be collected: OAuth creates profiles without
    // one and the onboarding screens that used to ask are being deleted.
    await POST(req({ email: "a@b.com", password: VALID, name: "A", age: 29 }))
    expect(mockDb.profiles.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ age: 29 }) })
    )
  })
})

describe("POST /api/mobile/auth/signup — account creation", () => {
  it("refuses an email that already exists", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "existing" })
    const res = await POST(req({ email: "a@b.com", password: VALID, name: "A" }))
    expect(res.status).toBe(409)
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it("creates the user and profile inside one transaction", async () => {
    await POST(req({ email: "a@b.com", password: VALID, name: "A" }))
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    expect(mockDb.user.create).toHaveBeenCalledTimes(1)
    expect(mockDb.profiles.create).toHaveBeenCalledTimes(1)
  })

  it("returns the profile, so the client can route without a second call", async () => {
    const res = await POST(req({ email: "a@b.com", password: VALID, name: "A" }))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.user.profile).toBeTruthy()
    expect(body.data.user.profile.onboarded).toBe(false)
    expect(body.data.accessToken).toEqual(expect.any(String))
    expect(body.data.refreshToken).toEqual(expect.any(String))
  })

  it("never returns the password hash", async () => {
    const res = await POST(req({ email: "a@b.com", password: VALID, name: "A" }))
    expect(JSON.stringify(await res.json())).not.toContain("password")
  })

  it("does not leave a user behind when the profile insert fails", async () => {
    /*
     * The reason for the transaction. These were two sequential creates, so a
     * failure here left a `User` that could authenticate but had no profile —
     * and the app routes on `profile.onboarded`, so that account lands nowhere
     * and cannot sign up again, because the email is now taken.
     */
    mockDb.$transaction.mockRejectedValue(new Error("profile insert failed"))
    const res = await POST(req({ email: "a@b.com", password: VALID, name: "A" }))
    expect(res.status).toBe(500)
  })
})
