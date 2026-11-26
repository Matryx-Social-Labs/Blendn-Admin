/**
 * SCRUM-1275: the mail 14 days before an organisation's free Analytics ends,
 * and the one market rule it (and design/05, insights/04) reads.
 */
import { BILLING_PLANS, grossRupees, rupees } from "@/lib/billing-plans"
import { freeWindowEndingEmail } from "@/lib/email"
import { mayBuyIn } from "@/lib/plan-market"

describe("mayBuyIn: may this organisation buy a plan where it runs events?", () => {
  it.each([
    ["every city in India", ["IN", "IN"], true],
    ["no events yet", [], true],
    ["India and Canada", ["IN", "CA"], false],
    ["Canada only", ["CA"], false],
    ["India and a city the catalogue does not know", ["IN", null], true],
    ["Canada and a city the catalogue does not know", ["CA", null], false],
  ] as const)("%s", (_label, countries, expected) => {
    expect(mayBuyIn(countries)).toBe(expected)
  })
})

describe("freeWindowEndingEmail, with worst-case values", () => {
  const orgName =
    "The Thiruvananthapuram Independent Music and Arts Collective of Kerala, Karnataka and Tamil Nadu (Registered Society)"
  // 23:30 UTC on 2 January is 3 January in India: the date is the Plan page's.
  const mail = freeWindowEndingEmail({ orgName, endsAt: new Date("2027-01-02T23:30:00Z") })
  const all = `${mail.subject}\n${mail.text}\n${mail.html}`

  it("says the end date as the Plan page does, with no time-zone label", () => {
    expect(mail.subject).toContain("3 Jan 2027")
    expect(mail.text).toContain("3 Jan 2027")
    expect(all).not.toMatch(/IST|UTC|GMT|Asia\//)
  })

  it("names today's prices from the price table, GST included and split", () => {
    for (const plan of [BILLING_PLANS.event_pass, BILLING_PLANS.analytics_monthly]) {
      expect(mail.text).toContain(rupees(grossRupees(plan)))
      expect(mail.text).toContain(rupees(plan.listRupees))
    }
    expect(mail.text).toContain("₹1,999")
    expect(mail.text).toContain("GST")
    for (const part of ["₹589", "₹2,359", "₹1,999", "3 Jan 2027"]) expect(mail.html).toContain(part)
  })

  it("uses the product names, says the data is kept and links the Plan page", () => {
    expect(mail.text).toContain("Event Insights")
    expect(mail.text).toContain("Analytics")
    expect(mail.text).toMatch(/kept|keep/)
    expect(mail.text).toContain("/dashboard/plan")
    expect(mail.html).toContain("/dashboard/plan")
  })

  it("promises no invoice and shows no blurred or partial figure", () => {
    expect(all).not.toMatch(/invoice|blur|█|\*\*\*/i)
  })

  it("leaves nothing unfilled and escapes the name in the HTML", () => {
    expect(all).not.toMatch(/undefined|NaN|\bnull\b|<placeholder>|\{\{|\$\{/)
    expect(mail.text).toContain(orgName)
    const evil = freeWindowEndingEmail({ orgName: "<script>x</script> & Co", endsAt: new Date("2027-01-02T00:00:00Z") })
    expect(evil.html).not.toContain("<script>x")
    expect(evil.html).toContain("&lt;script&gt;")
  })

  it("spells it organizer, never organiser", () => {
    expect(all).not.toMatch(/organis(er|ing)/i)
  })
})
