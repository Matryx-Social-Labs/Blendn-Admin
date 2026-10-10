import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

import { BILLING_PLANS, chargeMinor, grossRupees, gstSplit, isBillingPlanKey, reachBand, rupees } from "@/lib/billing-plans"
import { addMonths } from "@/lib/entitlements"

import { stripComments } from "./support/strip-comments"

jest.mock("@/lib/db", () => ({ db: {} }))

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

  it("prices Venue Pro per venue: ₹2,999 a month, a year at ten months (step 17, §9.1b)", () => {
    expect(BILLING_PLANS.venue_pro_monthly).toMatchObject({ product: "venue_pro", kind: "subscription", period: "monthly" })
    expect(BILLING_PLANS.venue_pro_yearly).toMatchObject({ product: "venue_pro", kind: "subscription", period: "yearly" })
    expect(gstSplit(BILLING_PLANS.venue_pro_monthly)).toBe("₹2,999 + ₹540 GST")
    expect(grossRupees(BILLING_PLANS.venue_pro_monthly)).toBe(3_539)
    // 29,990 × 1.18 = 35,388.2: two months free on twelve.
    expect(grossRupees(BILLING_PLANS.venue_pro_yearly)).toBe(35_388)
    expect(chargeMinor(BILLING_PLANS.venue_pro_monthly)).toBe(353_900)
  })

  it("bands a sponsor's delivered reach, with no band under the floor (step 17, audit §6.3)", () => {
    expect(reachBand(null)).toBeNull()
    expect(reachBand(4)).toBeNull()
    expect(reachBand(0)).toBeNull()
    expect(reachBand(5)?.key).toBe("5-49")
    expect(reachBand(49)?.key).toBe("5-49")
    expect(reachBand(50)?.key).toBe("50-149")
    expect(reachBand(399)?.key).toBe("150-399")
    expect(reachBand(400)?.key).toBe("400+")
  })

  it("knows its own keys and nothing else", () => {
    expect(isBillingPlanKey("event_pass")).toBe(true)
    expect(isBillingPlanKey("toString")).toBe(false)
    expect(isBillingPlanKey("plus")).toBe(false)
  })
})

/*
 * G11: a price is never worked out anywhere but the table. Every screen,
 * action and script reads `grossRupees` / `chargeMinor` / `gstSplit`; a
 * second file reading `listRupees` (the pre-GST figure) is how a page ends up
 * showing ₹1,999 beside a ₹2,359 charge.
 */

describe("listRupees is read by the price table alone", () => {
  const root = join(__dirname, "..")
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      if (e === "node_modules" || e === ".next") return []
      const full = join(dir, e)
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e) ? [full] : []
    })

  it("is named in lib/billing-plans.ts and nowhere else in the product", () => {
    const naming = ["app", "components", "lib", "scripts"]
      .flatMap((d) => walk(join(root, d)))
      .filter((f) => /\blistRupees\b/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(root, f))
    expect(naming).toEqual(["lib/billing-plans.ts"])
  })
})

describe("addMonths (G16): a grant ends on a real calendar day", () => {
  it("lands on the month's last day when the day does not exist there", () => {
    expect(addMonths(new Date("2026-10-31T12:00:00Z"), 6).toISOString()).toBe("2027-04-30T12:00:00.000Z")
    expect(addMonths(new Date("2026-08-31T12:00:00Z"), 6).toISOString()).toBe("2027-02-28T12:00:00.000Z")
    expect(addMonths(new Date("2027-08-31T12:00:00Z"), 6).toISOString()).toBe("2028-02-29T12:00:00.000Z")
  })

  it("keeps the day otherwise, across a year", () => {
    expect(addMonths(new Date("2026-10-03T12:00:00Z"), 6).toISOString()).toBe("2027-04-03T12:00:00.000Z")
    expect(addMonths(new Date("2026-01-15T00:00:00Z"), 24).toISOString()).toBe("2028-01-15T00:00:00.000Z")
  })
})
