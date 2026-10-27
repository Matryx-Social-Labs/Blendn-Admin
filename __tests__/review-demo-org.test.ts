/**
 * The review-organisation guard (lib/review-demo-org.ts) costs no query on an
 * ordinary save: it asks only when a request would take an event out of draft
 * or link a venue. That every door asks it, and what it answers, is
 * `integration/event-status-moves.itest.ts` through the real handlers.
 */
const findFirst = jest.fn(async () => null)
jest.mock("@/lib/db", () => ({ db: { audit_logs: { findFirst } } }))

import { leavesDraft } from "@/lib/event-status-move"
import { reviewOrgRefusal } from "@/lib/review-demo-org"

describe("reviewOrgRefusal", () => {
  beforeEach(() => findFirst.mockClear())

  it("asks nothing when the request leaves the event a draft and links no venue", async () => {
    expect(await reviewOrgRefusal("org-1", {})).toBeNull()
    expect(await reviewOrgRefusal("org-1", { leaveDraft: false, venue: false })).toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("asks the seeded audit row by the organisation's id when it does", async () => {
    expect(await reviewOrgRefusal("org-1", { leaveDraft: true })).toBeNull()
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: "razorpay_review.seeded", resource_id: "org-1" } })
    )
  })
})

describe("leavesDraft: every status but draft is a move out of it", () => {
  it.each([
    [undefined, null, false],
    ["draft", null, false],
    ["published", null, true],
    ["cancelled", null, true],
    ["completed", null, true],
    [undefined, "draft", false],
    ["draft", "draft", false],
    ["published", "draft", true],
    ["cancelled", "draft", true],
    ["completed", "draft", true],
    ["published", "published", false],
    ["draft", "published", false],
  ] as const)("%s from %s → %s", (next, current, expected) => {
    expect(leavesDraft(next, current)).toBe(expected)
  })
})
