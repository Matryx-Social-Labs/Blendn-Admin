/**
 * SCRUM-1320: venues get the same three months free as organisers (DECISIONS
 * 2026-11-25 night): a venue is chargeable 90 days after its first venue-day
 * check-in, and every line that says so reads "three months" or the
 * constant in days, never "four weeks" and never the constant divided by 7
 * (90 / 7 printed "12.857142857142858 weeks").
 */
import { readFileSync } from "fs"
import { join } from "path"

import { readinessFrom, VENUE_DATA_DAYS } from "@/lib/venue-plan"

jest.mock("@/lib/db", () => ({ db: {} }))

const DAY = 24 * 60 * 60 * 1000
const FIRST = new Date("2026-08-01T10:00:00Z")
const after = (days: number) => new Date(FIRST.getTime() + days * DAY)
const read = (file: string) => readFileSync(join(__dirname, "..", file), "utf8")

describe("a venue's three months", () => {
  it("is 90 days", () => {
    expect(VENUE_DATA_DAYS).toBe(90)
  })

  it("is not chargeable on day 89, nor a millisecond before day 90", () => {
    expect(readinessFrom(FIRST, after(89))).toMatchObject({ chargeable: false, dataDays: 89 })
    expect(readinessFrom(FIRST, new Date(after(90).getTime() - 1)).chargeable).toBe(false)
  })

  it("is chargeable from day 90, counted from the first check-in", () => {
    expect(readinessFrom(FIRST, after(90))).toEqual({ dataSince: FIRST, chargeableFrom: after(90), dataDays: 90, chargeable: true })
  })

  it("meters day 40 as 40 of 90, and never past 90", () => {
    expect(readinessFrom(FIRST, after(40))).toMatchObject({ dataDays: 40, chargeable: false, chargeableFrom: after(90) })
    expect(readinessFrom(FIRST, after(400)).dataDays).toBe(90)
  })
})

describe("the venue copy", () => {
  it.each(["lib/venue-plan.ts", "lib/billing-actions.ts", "app/dashboard/plan/venue-plan.tsx", "app/pricing/page.tsx"])(
    "%s never says four weeks",
    (file) => {
      expect(read(file)).not.toMatch(/four weeks|4 weeks/i)
    }
  )

  it("the venue Plan page never divides the constant", () => {
    expect(read("app/dashboard/plan/venue-plan.tsx")).not.toMatch(/VENUE_DATA_DAYS\s*\//)
  })

  it("the venue Plan card, /pricing and the buy refusal say three months", () => {
    expect(read("app/dashboard/plan/venue-plan.tsx")).toContain("Nothing is charged until a venue has three months of data from people going live there.")
    expect(read("app/pricing/page.tsx")).toContain("Venue Pro can be bought once the venue has three months of data.")
    const actions = read("lib/billing-actions.ts")
    expect(actions).toContain(": three months after people first went live here.`")
    expect(actions).toContain('"Venue Pro can be bought three months after people first go live at this venue."')
  })
})
