import { NextRequest } from "next/server"

// Mock constants before importing rate-limit
jest.mock("@/lib/constants", () => ({
  RATE_LIMIT_MAX_ENTRIES: 5,
  RATE_LIMIT_WINDOW: {
    SIGNIN: 900_000,
    SIGNUP: 3_600_000,
    GOOGLE_AUTH: 900_000,
    REFRESH: 900_000,
    BATCH: 60_000,
    CHECKIN: 600_000,
    ORGANISER_BROADCAST: 60_000,
    PRIVATE_MESSAGE: 60_000,
  },
  RATE_LIMIT_MAX_REQUESTS: {
    SIGNIN: 5,
    SIGNUP: 3,
    GOOGLE_AUTH: 10,
    REFRESH: 20,
    BATCH: 30,
    CHECKIN: 10,
    ORGANISER_BROADCAST: 3,
    PRIVATE_MESSAGE: 5,
  },
}))

import {
  rateLimit,
  createBatchRateLimit,
  createAuthRateLimit,
  createUserRateLimit,
} from "@/lib/rate-limit"
import { resetMemoryStore } from "@/lib/rate-limit-store"

function makeRequest(path = "/api/test", ip = "127.0.0.1"): NextRequest {
  const req = new NextRequest(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  })
  return req
}

beforeEach(() => resetMemoryStore())

describe("rateLimit", () => {
  beforeEach(() => {
    // Reset the module to clear the in-memory store between tests
    jest.resetModules()
  })

  it("allows requests under the limit", async () => {
    const req = makeRequest()
    const config = { windowMs: 60_000, maxRequests: 3 }

    const result1 = await rateLimit(req, config)
    const result2 = await rateLimit(req, config)
    const result3 = await rateLimit(req, config)

    expect(result1).toBeNull()
    expect(result2).toBeNull()
    expect(result3).toBeNull()
  })

  it("blocks requests over the limit with 429", async () => {
    const req = makeRequest()
    const config = { windowMs: 60_000, maxRequests: 2 }

    await rateLimit(req, config) // 1
    await rateLimit(req, config) // 2
    const result = await rateLimit(req, config) // 3 - should be blocked

    expect(result).not.toBeNull()
    expect(result!.status).toBe(429)
  })

  it("returns rate limit headers when blocked", async () => {
    const req = makeRequest()
    const config = { windowMs: 60_000, maxRequests: 1 }

    await rateLimit(req, config) // 1
    const result = await rateLimit(req, config) // blocked

    expect(result).not.toBeNull()
    expect(result!.headers.get("X-RateLimit-Limit")).toBe("1")
    expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0")
    expect(result!.headers.get("Retry-After")).toBeTruthy()

    const body = await result!.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe("Too many requests")
  })

  it("tracks different IPs separately", async () => {
    const config = { windowMs: 60_000, maxRequests: 1 }

    const result1 = await rateLimit(makeRequest("/api/test", "1.1.1.1"), config)
    const result2 = await rateLimit(makeRequest("/api/test", "2.2.2.2"), config)

    expect(result1).toBeNull()
    expect(result2).toBeNull()
  })
})

describe("createBatchRateLimit", () => {
  it("returns a valid config", async () => {
    const config = createBatchRateLimit()
    expect(config.windowMs).toBeGreaterThan(0)
    expect(config.maxRequests).toBeGreaterThan(0)
  })
})

describe("createAuthRateLimit", () => {
  it("returns configs for all auth types", async () => {
    for (const type of ["signin", "signup", "google", "refresh"] as const) {
      const config = createAuthRateLimit(type)
      expect(config.windowMs).toBeGreaterThan(0)
      expect(config.maxRequests).toBeGreaterThan(0)
      expect(config.keyGenerator).toBeDefined()
    }
  })
})

describe("createUserRateLimit", () => {
  it("keys on the user, not the IP, so one account cannot flood from many IPs", async () => {
    const config = createUserRateLimit("organiser-broadcast", "user_abc")
    const fromOneIp = makeRequest("/api/events/1/announcements", "1.1.1.1")
    const fromAnother = makeRequest("/api/events/1/announcements", "2.2.2.2")

    expect(config.keyGenerator!(fromOneIp)).toBe(config.keyGenerator!(fromAnother))
    expect(config.keyGenerator!(fromOneIp)).toBe("organiser-broadcast:user_abc")
  })

  it("gives different users separate buckets", async () => {
    const a = createUserRateLimit("private-message", "user_a")
    const b = createUserRateLimit("private-message", "user_b")
    const req = makeRequest("/api/mobile/conversations/1/messages")

    expect(a.keyGenerator!(req)).not.toBe(b.keyGenerator!(req))
  })

  it("keeps broadcast and DM scopes in separate buckets for the same user", async () => {
    const broadcast = createUserRateLimit("organiser-broadcast", "user_abc")
    const dm = createUserRateLimit("private-message", "user_abc")
    const req = makeRequest("/api/x")

    expect(broadcast.keyGenerator!(req)).not.toBe(dm.keyGenerator!(req))
  })

  it("actually blocks once the per-user budget is spent", async () => {
    const config = createUserRateLimit("organiser-broadcast", "user_spammer")
    const req = makeRequest("/api/events/1/announcements")

    let blocked = null
    for (let i = 0; i < config.maxRequests + 1; i++) {
      blocked = await rateLimit(req, config)
    }

    expect(blocked).not.toBeNull()
    expect(blocked!.status).toBe(429)
  })
})
