import { BILLING_PLANS, chargeMinor, grossRupees, gstSplit, isBillingPlanKey, rupees } from "@/lib/billing-plans"

/*
 * The one price table (plan v2 §9.1b): list prices before 18% GST, shown and
 * charged with GST in, rounded to the rupee. The figures are the plan's.
 */
describe("the price table", () => {
  it("charges the plan's GST-inclusive prices", () => {
    expect(grossRupees(BILLING_PLANS.analytics_monthly)).toBe(2_359)
    expect(grossRupees(BILLING_PLANS.event_pass)).toBe(589)
    // 19,990 × 1.18 = 23,588.2
    expect(grossRupees(BILLING_PLANS.analytics_yearly)).toBe(23_588)
  })

  it("asks Razorpay for paise, not rupees", () => {
    expect(chargeMinor(BILLING_PLANS.analytics_monthly)).toBe(235_900)
    expect(chargeMinor(BILLING_PLANS.event_pass)).toBe(58_900)
  })

  it("prints the split the invoice will carry", () => {
    expect(gstSplit(BILLING_PLANS.analytics_monthly)).toBe("₹1,999 + ₹360 GST")
    expect(gstSplit(BILLING_PLANS.event_pass)).toBe("₹499 + ₹90 GST")
    expect(rupees(23_588)).toBe("₹23,588")
  })

  it("knows its own keys and nothing else", () => {
    expect(isBillingPlanKey("event_pass")).toBe(true)
    expect(isBillingPlanKey("toString")).toBe(false)
    expect(isBillingPlanKey("plus")).toBe(false)
  })
})
