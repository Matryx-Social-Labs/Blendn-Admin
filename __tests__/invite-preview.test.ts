process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * `GET /friends/invite/:token/preview` — the one friends route a stranger can
 * reach, with no account at all.
 *
 * What it must never do is say more than the signed-in route, or say it to a
 * person the signed-in route would refuse. A first name and a photo; the same
 * 404 for every refusal; a per-IP ceiling because there is no account to key on.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockInvite = jest.fn()
jest.mock("@/lib/db", () => ({ db: { friend_invites: { findUnique: (...a: unknown[]) => mockInvite(...a) } } }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a) }))

const mockMayConnect = jest.fn()
jest.mock("@/lib/friends", () => ({
  ...jest.requireActual("@/lib/friends"),
  mayConnect: (...a: unknown[]) => mockMayConnect(...a),
}))
jest.mock("@/lib/tigris", () => ({ getAccessibleMediaUrl: (u: string) => `https://cdn.test/${u}` }))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/mobile/friends/invite/[token]/preview/route"
import { resetMemoryStore } from "@/lib/rate-limit-store"

const TOKEN = "abcdefghijklmnopqrstuv" // 22 chars, base64url

const owner = (over: Record<string, unknown> = {}) => ({
  user: {
    id: "user_owner",
    name: "Priya Raman",
    image: null,
    profile: { name: "Priya Raman", photos: ["photos/priya.jpg", "photos/second.jpg"] },
    deletedAt: null,
    suspended_at: null,
    ...over,
  },
})

async function call(token = TOKEN, ip = "203.0.113.7") {
  const res = await GET(
    new NextRequest(`https://api.blendn.app/api/mobile/friends/invite/${token}/preview`, {
      headers: { "x-real-ip": ip },
    }),
    { params: Promise.resolve({ token }) }
  )
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  jest.clearAllMocks()
  resetMemoryStore()
  mockAuth.mockResolvedValue(null)
  mockInvite.mockResolvedValue(owner())
  mockMayConnect.mockResolvedValue(true)
})

it("answers a signed-out caller with a first name and one photo — nothing else", async () => {
  const res = await call()
  expect(res.status).toBe(200)
  expect(res.json).toEqual({
    success: true,
    data: { name: "Priya", photoUrl: "https://cdn.test/photos/priya.jpg" },
  })
  // No id, no full name, no friend state.
  expect(JSON.stringify(res.json)).not.toContain("user_owner")
  expect(JSON.stringify(res.json)).not.toContain("Raman")
})

it("needs no authentication", async () => {
  mockAuth.mockResolvedValue(null)
  expect((await call()).status).toBe(200)
  expect(mockMayConnect).not.toHaveBeenCalled()
})

it("answers a null photo rather than inventing one", async () => {
  mockInvite.mockResolvedValue(owner({ image: null, profile: { name: "Sam", photos: [] } }))
  expect((await call()).json.data).toEqual({ name: "Sam", photoUrl: null })
})

it.each([
  ["a malformed token", () => undefined, "short"],
  ["an unknown or reset token", () => mockInvite.mockResolvedValue(null), TOKEN],
  ["a deleted owner", () => mockInvite.mockResolvedValue(owner({ deletedAt: new Date() })), TOKEN],
  ["a suspended owner", () => mockInvite.mockResolvedValue(owner({ suspended_at: new Date() })), TOKEN],
])("answers the signed-in route's one 404 for %s", async (_l, arrange, token) => {
  arrange()
  const res = await call(token)
  expect(res.status).toBe(404)
  expect(res.json).toEqual({ success: false, error: "This invite link doesn't work any more", errorCode: "NOT_FOUND" })
})

it("applies the block rule to a caller who is signed in", async () => {
  mockAuth.mockResolvedValue({ userId: "user_blocked", email: "b@b.com" })
  mockMayConnect.mockResolvedValue(false)
  const res = await call()
  expect(res.status).toBe(404)
  expect(res.json.errorCode).toBe("NOT_FOUND")
  expect(mockMayConnect).toHaveBeenCalledWith("user_blocked", "user_owner")
})

it("lets the owner preview their own link", async () => {
  mockAuth.mockResolvedValue({ userId: "user_owner", email: "o@b.com" })
  expect((await call()).status).toBe(200)
  expect(mockMayConnect).not.toHaveBeenCalled()
})

it("is rate-limited per IP, across tokens", async () => {
  for (let i = 0; i < 20; i++) expect((await call(TOKEN, "198.51.100.1")).status).toBe(200)
  const over = await call("zyxwvutsrqponmlkjihgfe", "198.51.100.1")
  expect(over.status).toBe(429)
  expect(over.json.errorCode).toBe("RATE_LIMITED")
  // Another address has its own allowance.
  expect((await call(TOKEN, "198.51.100.2")).status).toBe(200)
})
