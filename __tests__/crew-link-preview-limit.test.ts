import { NextRequest } from "next/server"

jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
const hit = jest.fn()
jest.mock("@/lib/rate-limit-store", () => ({ hit: (...args: unknown[]) => hit(...args) }))
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: async () => null }))
jest.mock("@/lib/crews/links", () => ({ crewLinkPreview: async () => null, NO_LINK: "no_link" }))
jest.mock("@/lib/crews/crews", () => ({ refusalResponse: () => new Response(null, { status: 404 }) }))

import { GET } from "@/app/api/mobile/crews/links/[token]/preview/route"

/**
 * The landing (www.blendn.app/c/<token>) calls the preview from Vercel. Keyed
 * on the caller's address, every visitor behind one Vercel node shared 20 a
 * minute. The landing forwards the visitor, and is believed only with the secret.
 */
const SECRET = "share-proxy-secret-0123456789abcdef0123"
const VERCEL = "198.51.100.7"
const VISITOR = "203.0.113.9"

beforeEach(() => {
  process.env.SHARE_PROXY_SECRET = SECRET
  hit.mockReset()
  hit.mockResolvedValue({ count: 1, resetAt: Date.now() + 60_000 })
})
afterAll(() => {
  delete process.env.SHARE_PROXY_SECRET
})

async function keyFor(headers: Record<string, string>): Promise<string> {
  const req = new NextRequest("http://localhost/api/mobile/crews/links/tok/preview", { headers })
  await GET(req, { params: Promise.resolve({ token: "tok" }) })
  return hit.mock.calls[0]![0] as string
}

describe("crew link preview limit", () => {
  it("counts the visitor the landing forwards with the secret", async () => {
    expect(await keyFor({ "x-real-ip": VERCEL, "x-share-proxy": SECRET, "x-share-client": VISITOR })).toBe(
      `rl:crew-link-preview:${VISITOR}`
    )
  })

  it("ignores a forwarded visitor with a wrong or absent secret", async () => {
    expect(await keyFor({ "x-real-ip": VERCEL, "x-share-client": VISITOR })).toBe(`rl:crew-link-preview:${VERCEL}`)
    hit.mockClear()
    expect(await keyFor({ "x-real-ip": VERCEL, "x-share-proxy": SECRET.slice(0, -1) + "X", "x-share-client": VISITOR })).toBe(
      `rl:crew-link-preview:${VERCEL}`
    )
  })

  it("keys the app's own call on its address, an IPv6 client on its /64", async () => {
    expect(await keyFor({ "x-real-ip": "2001:db8:1:2:aaaa::1" })).toBe("rl:crew-link-preview:2001:db8:1:2::/64")
  })
})
