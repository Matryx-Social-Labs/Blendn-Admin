/*
 * MN-G04: a key's mode is held to its environment. A live key outside
 * production charges real money from staging; a test key in production hands
 * out Analytics for test money. Both are refused at boot (`validateEnv`) and at
 * the moment of a call (`razorpayConfig`).
 */
import { razorpayKeyModeProblem, validateEnv } from "@/lib/env"
import { razorpayConfig } from "@/lib/razorpay"

const BASE = {
  DATABASE_URL: "postgresql://x",
  NEXTAUTH_URL: "http://localhost:3000",
  NEXTAUTH_SECRET: "x".repeat(32),
  MOBILE_JWT_SECRET: "y".repeat(32),
}

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

function withEnv(extra: Record<string, string | undefined>) {
  process.env = { ...saved, ...BASE, ...extra } as NodeJS.ProcessEnv
}

describe("razorpayKeyModeProblem", () => {
  it("allows a test key outside production and a live key in production", () => {
    expect(razorpayKeyModeProblem("rzp_test_abc", "staging")).toBeNull()
    expect(razorpayKeyModeProblem("rzp_test_abc", undefined)).toBeNull()
    expect(razorpayKeyModeProblem("rzp_live_abc", "production")).toBeNull()
    expect(razorpayKeyModeProblem(undefined, "production")).toBeNull()
  })

  it("refuses a live key on staging and locally, and a test key in production", () => {
    expect(razorpayKeyModeProblem("rzp_live_abc", "staging")).toMatch(/live key outside production/)
    expect(razorpayKeyModeProblem("rzp_live_abc", undefined)).toMatch(/live key outside production/)
    expect(razorpayKeyModeProblem("rzp_test_abc", "production")).toMatch(/test key in production/)
  })
})

describe("validateEnv", () => {
  it("boots with no Razorpay keys at all: payments are simply off", () => {
    withEnv({ RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: undefined })
    expect(() => validateEnv()).not.toThrow()
  })

  it("refuses to boot staging with a live key", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_ID: "rzp_live_abc", RAZORPAY_KEY_SECRET: "s".repeat(20) })
    expect(() => validateEnv()).toThrow("Invalid environment variables")
  })

  it("refuses to boot production with a test key", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "production", RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "s".repeat(20) })
    expect(() => validateEnv()).toThrow("Invalid environment variables")
  })

  it("refuses half a key pair", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: undefined })
    expect(() => validateEnv()).toThrow("Invalid environment variables")
  })

  it("boots staging with a test pair", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "s".repeat(20) })
    expect(() => validateEnv()).not.toThrow()
  })
})

describe("razorpayConfig", () => {
  it("is off without keys", () => {
    withEnv({ RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: undefined })
    expect(razorpayConfig()).toBeNull()
  })

  it("refuses a live key outside production even when validateEnv never ran", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_ID: "rzp_live_abc", RAZORPAY_KEY_SECRET: "s".repeat(20) })
    expect(() => razorpayConfig()).toThrow(/live key outside production/)
  })
})
