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
  },
  RATE_LIMIT_MAX_REQUESTS: {
    SIGNIN: 5,
    SIGNUP: 3,
    GOOGLE_AUTH: 10,
    REFRESH: 20,
    BATCH: 30,
    CHECKIN: 10,
  },
}))

import { rateLimit, createBatchRateLimit, createAuthRateLimit } from "@/lib/rate-limit"

function makeRequest(path = "/api/test", ip = "127.0.0.1"): NextRequest {
  const req = new NextRequest(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  })
  return req
}

describe("rateLimit", () => {
  beforeEach(() => {
    // Reset the module to clear the in-memory store between tests
    jest.resetModules()
  })

  it("allows requests under the limit", () => {
    const req = makeRequest()
    const config = { windowMs: 60_000, maxRequests: 3 }

    const result1 = rateLimit(req, config)
    const result2 = rateLimit(req, config)
    const result3 = rateLimit(req, config)

    expect(result1).toBeNull()
    expect(result2).toBeNull()
    expect(result3).toBeNull()
  })

  it("blocks requests over the limit with 429", () => {
    const req = makeRequest()
    const config = { windowMs: 60_000, maxRequests: 2 }

    rateLimit(req, config) // 1
    rateLimit(req, config) // 2
    const result = rateLimit(req, config) // 3 - should be blocked

    expect(result).not.toBeNull()
    expect(result!.status).toBe(429)
  })

  it("returns rate limit headers when blocked", async () => {
    const req = makeRequest()
    const config = { windowMs: 60_000, maxRequests: 1 }

    rateLimit(req, config) // 1
    const result = rateLimit(req, config) // blocked

    expect(result).not.toBeNull()
    expect(result!.headers.get("X-RateLimit-Limit")).toBe("1")
    expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0")
    expect(result!.headers.get("Retry-After")).toBeTruthy()

    const body = await result!.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe("Too many requests")
  })

  it("tracks different IPs separately", () => {
    const config = { windowMs: 60_000, maxRequests: 1 }

    const result1 = rateLimit(makeRequest("/api/test", "1.1.1.1"), config)
    const result2 = rateLimit(makeRequest("/api/test", "2.2.2.2"), config)

    expect(result1).toBeNull()
    expect(result2).toBeNull()
  })
})

describe("createBatchRateLimit", () => {
  it("returns a valid config", () => {
    const config = createBatchRateLimit()
    expect(config.windowMs).toBeGreaterThan(0)
    expect(config.maxRequests).toBeGreaterThan(0)
  })
})

describe("createAuthRateLimit", () => {
  it("returns configs for all auth types", () => {
    for (const type of ["signin", "signup", "google", "refresh"] as const) {
      const config = createAuthRateLimit(type)
      expect(config.windowMs).toBeGreaterThan(0)
      expect(config.maxRequests).toBeGreaterThan(0)
      expect(config.keyGenerator).toBeDefined()
    }
  })
})
