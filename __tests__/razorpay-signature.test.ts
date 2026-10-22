import { createHmac } from "crypto"

import { BILLING_PLANS } from "@/lib/billing-plans"
import { planMatches, verifyWebhookSignature, type RazorpayPlan } from "@/lib/razorpay"

/*
 * MN-U02: the webhook signature, over the raw BYTES, constant-time, never
 * throwing. The body below is deliberately NOT what JSON.stringify would
 * produce (spacing, key order) and carries a multi-byte character, so a
 * verifier that re-serialises, or decodes and re-encodes, fails it.
 */
const SECRET = "whsec_test_secret_for_unit_tests_0123456789"
const RAW = '{"event":"order.paid",  "payload":{"order":{"entity":{"id":"order_1","receipt":"Café"}}},"created_at":1}'
const BYTES = new TextEncoder().encode(RAW)
const sign = (body: string | Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex")

describe("verifyWebhookSignature", () => {
  it("accepts Razorpay's HMAC of the exact bytes, as bytes or as the same string", () => {
    expect(verifyWebhookSignature(BYTES, sign(BYTES), SECRET)).toBe(true)
    expect(verifyWebhookSignature(RAW, sign(RAW), SECRET)).toBe(true)
  })

  it("accepts the same signature in upper case and with surrounding space", () => {
    expect(verifyWebhookSignature(BYTES, sign(BYTES).toUpperCase(), SECRET)).toBe(true)
    expect(verifyWebhookSignature(BYTES, ` ${sign(BYTES)} `, SECRET)).toBe(true)
  })

  it("refuses the HMAC of a re-serialised body", () => {
    const reserialised = JSON.stringify(JSON.parse(RAW))
    expect(reserialised).not.toBe(RAW)
    expect(verifyWebhookSignature(BYTES, sign(reserialised), SECRET)).toBe(false)
  })

  it("refuses a body changed by one byte", () => {
    const changed = new Uint8Array(BYTES)
    changed[10] ^= 1
    expect(verifyWebhookSignature(changed, sign(BYTES), SECRET)).toBe(false)
  })

  it("refuses a missing header, the wrong secret, a different length and non-hex, without throwing", () => {
    expect(verifyWebhookSignature(BYTES, null, SECRET)).toBe(false)
    expect(verifyWebhookSignature(BYTES, undefined, SECRET)).toBe(false)
    expect(verifyWebhookSignature(BYTES, "", SECRET)).toBe(false)
    expect(verifyWebhookSignature(BYTES, sign(BYTES, "another_secret_entirely_0123456789abcd"), SECRET)).toBe(false)
    expect(verifyWebhookSignature(BYTES, sign(BYTES).slice(0, 10), SECRET)).toBe(false)
    expect(verifyWebhookSignature(BYTES, sign(BYTES) + "00", SECRET)).toBe(false)
    expect(verifyWebhookSignature(BYTES, "z".repeat(64), SECRET)).toBe(false)
    expect(verifyWebhookSignature(BYTES, sign(BYTES), "")).toBe(false)
  })
})

describe("planMatches", () => {
  const monthly: RazorpayPlan = {
    id: "plan_1",
    period: "monthly",
    interval: 1,
    item: { name: "x", amount: 235_900, currency: "INR" },
    notes: { key: "analytics_monthly" },
  }

  it("finds the plan with our key, our price and our period", () => {
    expect(planMatches(monthly, BILLING_PLANS.analytics_monthly)).toBe(true)
  })

  it("stops matching when the price in the table is not the plan's price", () => {
    expect(planMatches({ ...monthly, item: { ...monthly.item, amount: 199_900 } }, BILLING_PLANS.analytics_monthly)).toBe(false)
    expect(planMatches({ ...monthly, period: "yearly" }, BILLING_PLANS.analytics_monthly)).toBe(false)
    expect(planMatches({ ...monthly, notes: [] }, BILLING_PLANS.analytics_monthly)).toBe(false)
    expect(planMatches(monthly, BILLING_PLANS.analytics_yearly)).toBe(false)
  })
})
