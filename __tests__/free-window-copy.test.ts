/**
 * SCRUM-1269: the free window is 90 days from the first night with 8 people
 * checked in (DECISIONS 2026-11-25), and every page that states it reads the
 * constants, so the old rule (30 days, five people) cannot survive in copy.
 * No page promises an invoice: Event Insights is a plain Razorpay Order and
 * nothing sends a GSTIN (be-payments verification 4; the legal Epic decides).
 */
import { readFileSync } from "fs"
import { join } from "path"

import { FREE_WINDOW_DAYS } from "@/lib/analytics-access"
import { MIN_ATTENDEES } from "@/lib/connection-metrics"

jest.mock("@/lib/db", () => ({ db: {} }))

const read = (file: string) => readFileSync(join(__dirname, "..", file), "utf8")

const FREE_WINDOW_COPY = ["lib/access-line-copy.ts", "app/dashboard/plan/page.tsx", "app/dashboard/analytics/page.tsx", "app/pricing/page.tsx", "app/apply/page.tsx"]
// The policy pages (/contact, /refunds, /shipping) are legal wording: handed to SCRUM-1162, not guarded here.
const PAYMENT_COPY = ["app/dashboard/plan/page.tsx", "app/dashboard/plan/venue-plan.tsx", "app/pricing/page.tsx"]

describe("the free window in copy", () => {
  it("is 90 days from the first night with 8 people", () => {
    expect(FREE_WINDOW_DAYS).toBe(90)
    expect(MIN_ATTENDEES).toBe(8)
  })

  it.each(FREE_WINDOW_COPY)("%s never states the old rule as a literal", (file) => {
    const text = read(file)
    expect(text).not.toMatch(/\b30 days after\b|\bfor 30 days\b/)
    expect(text).not.toMatch(/\b(5|five|six) people\b/i)
    expect(text).not.toMatch(/cleared the floor/i)
  })

  it.each(["lib/access-line-copy.ts", "app/dashboard/plan/page.tsx", "app/pricing/page.tsx"])("%s interpolates both constants", (file) => {
    const text = read(file)
    expect(text).toMatch(/\{FREE_WINDOW_DAYS\}/)
    expect(text).toMatch(/\{MIN_ATTENDEES\}/)
  })

  // A client page cannot import the server constant; it says "three months", which is 90 days.
  it("Apply says three months free", () => {
    expect(read("app/apply/page.tsx")).toContain("Analytics is free for your first three months of events, then an optional paid plan.")
  })
})

describe("payment copy", () => {
  it.each(PAYMENT_COPY)("%s promises no invoice", (file) => {
    expect(read(file)).not.toMatch(/invoice/i)
  })

  // SCRUM-1340: Blend'n+ is out of 1.0 (DECISIONS gate 5) and one event's product is "Event Insights".
  it.each(PAYMENT_COPY)("%s sells no Blend'n+ and names no Event Pass", (file) => {
    const text = read(file)
    expect(text).not.toMatch(/Blend(&apos;|'|’)?n\+/i)
    expect(text).not.toMatch(/Event\s+Pass/i)
  })
})
