import { createHmac } from "crypto"

import { BILLING_PLANS } from "@/lib/billing-plans"
import { planMatches, verifyWebhookSignature, type RazorpayPlan } from "@/lib/razorpay"

/*
 * MN-U02: the webhook signature, over the raw body, constant-time, never
 * throwing. The body below is deliberately NOT what JSON.stringify would
 * produce (spacing, key order), so a verifier that re-serialises fails it.
 */
const SECRET = "whsec_test_secret_for_unit_tests"
const RAW = '{"event":"order.paid",  "payload":{"order":{"entity":{"id":"order_1"}}},"created_at":1}'
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex")

describe("verifyWebhookSignature", () => {
  it("accepts Razorpay's HMAC of the exact bytes", () => {
    expect(verifyWebhookSignature(RAW, sign(RAW), SECRET)).toBe(true)
  })

  it("refuses the HMAC of a re-serialised body", () => {
    const reserialised = JSON.stringify(JSON.parse(RAW))
    expect(reserialised).not.toBe(RAW)
    expect(verifyWebhookSignature(RAW, sign(reserialised), SECRET)).toBe(false)
  })

  it("refuses a body changed by one byte", () => {
    expect(verifyWebhookSignature(RAW.replace("order_1", "order_2"), sign(RAW), SECRET)).toBe(false)
  })

  it("refuses a missing header, the wrong secret, and a different length, without throwing", () => {
    expect(verifyWebhookSignature(RAW, null, SECRET)).toBe(false)
    expect(verifyWebhookSignature(RAW, undefined, SECRET)).toBe(false)
    expect(verifyWebhookSignature(RAW, "", SECRET)).toBe(false)
    expect(verifyWebhookSignature(RAW, sign(RAW, "another_secret_entirely"), SECRET)).toBe(false)
    expect(verifyWebhookSignature(RAW, sign(RAW).slice(0, 10), SECRET)).toBe(false)
    expect(verifyWebhookSignature(RAW, sign(RAW) + "00", SECRET)).toBe(false)
    expect(verifyWebhookSignature(RAW, sign(RAW), "")).toBe(false)
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
