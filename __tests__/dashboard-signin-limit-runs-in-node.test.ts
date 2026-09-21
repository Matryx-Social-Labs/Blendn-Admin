import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest, NextResponse } from "next/server"

/*
 * The dashboard sign-in limit runs in the Node runtime (SCRUM-194).
 *
 * Driven on staging: seven wrong passwords showed the lockout sentence, then
 * six more POSTs from the same network went 302 302 429 302 302 302 — the
 * limiter lived in the Edge middleware, where Redis cannot load and the
 * in-process fallback does not survive between invocations. This pins the
 * limiter to the NextAuth route and keeps it out of the middleware.
 */
const mockHandler = jest.fn()
const mockRateLimit = jest.fn()
const mockConfig = jest.fn((type: string) => ({ type }))

jest.mock("next-auth", () => () => mockHandler)
jest.mock("@/lib/auth", () => ({ authOptions: {} }))
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
  createAuthRateLimit: (type: string) => mockConfig(type),
}))

import { GET, POST } from "@/app/api/auth/[...nextauth]/route"

const ctx = { params: Promise.resolve({ nextauth: ["callback", "credentials"] }) }
const post = (path: string) =>
  POST(new NextRequest(`http://localhost${path}`, { method: "POST" }), ctx)

beforeEach(() => {
  jest.clearAllMocks()
  mockHandler.mockResolvedValue(new NextResponse(null, { status: 302 }))
  mockRateLimit.mockResolvedValue(null)
})

describe("POST /api/auth/callback/credentials", () => {
  it("asks the dashboard-signin limiter before NextAuth sees the password", async () => {
    await post("/api/auth/callback/credentials")
    expect(mockConfig).toHaveBeenCalledWith("dashboard-signin")
    expect(mockRateLimit).toHaveBeenCalledTimes(1)
    expect(mockHandler).toHaveBeenCalledTimes(1)
  })

  it("returns the limiter's 429 and never reaches NextAuth once locked out", async () => {
    const locked = NextResponse.json({ success: false, error: "Too many requests" }, { status: 429 })
    mockRateLimit.mockResolvedValue(locked)
    const res = await post("/api/auth/callback/credentials")
    expect(res.status).toBe(429)
    expect(mockHandler).not.toHaveBeenCalled()
  })

  it("leaves every other auth path alone", async () => {
    await post("/api/auth/signout")
    expect(mockRateLimit).not.toHaveBeenCalled()
    expect(mockHandler).toHaveBeenCalledTimes(1)
    expect(GET).toBe(mockHandler)
  })
})

describe("the middleware", () => {
  it("no longer carries the limiter — the Edge runtime is where it silently stopped working", () => {
    const src = readFileSync(join(__dirname, "..", "middleware.ts"), "utf8")
    expect(src).not.toMatch(/dashboard-signin/)
    expect(src).not.toMatch(/callback\/credentials/)
  })
})
