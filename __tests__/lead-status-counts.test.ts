import { leadStatusCounts } from "@/lib/lead-queries"

jest.mock("@/lib/db", () => ({ db: {} }))

/*
 * The counts beside the Leads screen's status pills (step 18). "Open" is the
 * statuses the inbox reads as open — new, contacted, qualified — and never a
 * closed one; "All" is every lead; a status with no rows is 0, not missing.
 */
describe("leadStatusCounts", () => {
  it("counts each status, the open ones together, and all of them", () => {
    const counts = leadStatusCounts([
      { status: "new", count: 3 },
      { status: "contacted", count: 2 },
      { status: "qualified", count: 1 },
      { status: "converted", count: 4 },
      { status: "archived", count: 5 },
      { status: "spam", count: 6 },
    ])
    expect(counts).toEqual({ new: 3, contacted: 2, qualified: 1, converted: 4, archived: 5, spam: 6, open: 6, all: 21 })
  })

  it("reads a status nobody has as 0", () => {
    expect(leadStatusCounts([{ status: "spam", count: 2 }])).toEqual({
      new: 0,
      contacted: 0,
      qualified: 0,
      converted: 0,
      archived: 0,
      spam: 2,
      open: 0,
      all: 2,
    })
  })
})
