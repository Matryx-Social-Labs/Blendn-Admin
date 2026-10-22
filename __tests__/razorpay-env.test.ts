/*
 * MN-G04: a key's mode is held to its environment, and keys never run
 * without the webhook secret. A live key outside production charges real money
 * from staging; a test key in production hands out Analytics for test money;
 * keys without the secret take money and grant nothing. Each is refused at
 * boot (`validateEnv`) and at the moment of a call (`razorpayKeys`).
 */
import { razorpayKeyModeProblem, razorpayKeys, razorpayWebhookSecret, validateEnv } from "@/lib/env"

const BASE = {
  DATABASE_URL: "postgresql://x",
  NEXTAUTH_URL: "http://localhost:3000",
  NEXTAUTH_SECRET: "x".repeat(32),
  MOBILE_JWT_SECRET: "y".repeat(32),
}
const KEY_SECRET = "k".repeat(24) // Razorpay's own length today
const HOOK_SECRET = "h".repeat(32)

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
  it("boots with no Razorpay variables at all: payments are simply off (staging today)", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: undefined, RAZORPAY_WEBHOOK_SECRET: undefined })
    expect(() => validateEnv()).not.toThrow()
  })

  it.each([
    ["a live key on staging", { RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_ID: "rzp_live_abc" }],
    ["a test key in production", { RAILWAY_ENVIRONMENT_NAME: "production", RAZORPAY_KEY_ID: "rzp_test_abc" }],
    ["half a key pair", { RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: undefined }],
    ["keys without the webhook secret", { RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_WEBHOOK_SECRET: undefined }],
    ["a 31-character webhook secret", { RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_WEBHOOK_SECRET: "h".repeat(31) }],
    ["a 15-character key secret", { RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "k".repeat(15) }],
  ])("refuses to boot with %s", (_label, extra) => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET, ...extra })
    expect(() => validateEnv()).toThrow("Invalid environment variables")
  })

  it("boots staging with a test key, Razorpay's 24-character secret and our 32-character webhook secret", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET })
    expect(() => validateEnv()).not.toThrow()
  })
})

describe("razorpayKeys", () => {
  it("is off without keys, and off with keys but no webhook secret", () => {
    withEnv({ RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: undefined, RAZORPAY_WEBHOOK_SECRET: undefined })
    expect(razorpayKeys()).toBeNull()
    withEnv({ RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: undefined })
    expect(razorpayKeys()).toBeNull()
    expect(razorpayWebhookSecret()).toBeNull()
  })

  it("is on with all three, in the right mode", () => {
    withEnv({ RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET })
    expect(razorpayKeys()).toEqual({ keyId: "rzp_test_abc", keySecret: KEY_SECRET })
  })

  it("refuses a live key outside production even when validateEnv never ran", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", RAZORPAY_KEY_ID: "rzp_live_abc", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET })
    expect(() => razorpayKeys()).toThrow(/live key outside production/)
  })
})
