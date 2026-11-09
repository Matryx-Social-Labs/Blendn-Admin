const mockUser = jest.fn()
const mockUpsert = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: () => mockUser() }))
jest.mock("@/lib/db", () => ({ db: { city_demand: { upsert: (args: unknown) => mockUpsert(args) } } }))
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  userLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { NextRequest } from "next/server"
import { POST } from "@/app/api/mobile/events/demand/route"

/*
 * SCRUM-997. A Toronto row written before the app sent a country stayed
 * `country: null` however many times a Canadian phone opened it afterwards:
 * the upsert's `update` never set it. Read back on staging 2026-11-01 — Toronto
 * | null | opens 2 → 6.
 */
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/mobile/events/demand", { method: "POST", body: JSON.stringify(body) }))
const upserted = () => mockUpsert.mock.calls[0][0] as { update: Record<string, unknown>; create: Record<string, unknown> }

beforeEach(() => {
  mockUpsert.mockReset().mockResolvedValue({})
  mockUser.mockResolvedValue({ userId: "u1" })
})

describe("POST /events/demand — the country of a city with nothing on", () => {
  it("fills the country on a row that already exists, not only on a new one", async () => {
    expect((await post({ city: "Toronto", country: "CA" })).status).toBe(200)
    expect(upserted().update).toMatchObject({ country: "CA" })
    expect(upserted().create).toMatchObject({ country: "CA" })
  })

  it("never clears a known country when a later open sends none", async () => {
    await post({ city: "Toronto" })
    expect(upserted().update).not.toHaveProperty("country")
    expect(upserted().create).toMatchObject({ country: null })
  })
})
