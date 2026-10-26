/**
 * Razorpay's reviewer may put nothing in front of a real person
 * (lib/review-demo-org.ts). Every server door that would — publishing an
 * event through either API, linking a venue, adding a venue, inviting by
 * email — asks the guard; the guard costs no query when a request wants none
 * of that. What the guard answers is `integration/seed-razorpay-review.itest.ts`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

const findFirst = jest.fn(async () => null)
jest.mock("@/lib/db", () => ({ db: { audit_logs: { findFirst } } }))

import { reviewOrgRefusal } from "@/lib/review-demo-org"

const root = path.join(__dirname, "..")
const code = (f: string) =>
  readFileSync(path.join(root, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

/** The body of one exported function, up to the next top-level export. */
function body(file: string, fn: string): string {
  const src = code(file)
  const start = src.indexOf(`export async function ${fn}(`)
  if (start < 0) throw new Error(`${fn} not found in ${file}`)
  const next = src.indexOf("\nexport ", start + 1)
  return src.slice(start, next < 0 ? undefined : next)
}

describe("every door that reaches a real person asks the guard", () => {
  it.each([
    ["app/api/events/route.ts", "POST", /reviewOrgRefusal\(owningOrgId, \{\s*publish: \(status \?\? "draft"\) === "published",\s*venue: Boolean\(venue_id\)/],
    ["app/api/events/[id]/route.ts", "PATCH", /reviewOrgRefusal\(event\.organizer_org_id, \{\s*publish: status === "published" && event\.status !== "published",\s*venue: venue_id !== undefined/],
    ["app/api/mobile/events/[eventId]/route.ts", "PATCH", /reviewOrgRefusal\(event\.organizer_org_id, \{ publish: true \}\)/],
  ])("%s %s", (file, fn, call) => {
    const handler = body(file, fn)
    expect(handler).toMatch(call)
    expect(handler).toMatch(/if \(reviewRefusal\) return /)
  })

  it.each([
    ["lib/venue-actions.ts", "createVenue"],
    ["lib/org-actions.ts", "inviteMember"],
    ["lib/org-actions.ts", "sendDomainVerifyEmail"],
  ])("%s %s", (file, fn) => {
    expect(body(file, fn)).toMatch(/if \(await isRazorpayReviewOrg\(orgId\)\)[\s{]*throw new Refusal\(REVIEW_ORG_REFUSAL\)/)
  })
})

describe("reviewOrgRefusal", () => {
  beforeEach(() => findFirst.mockClear())

  it("asks nothing when the request publishes nothing and links no venue", async () => {
    expect(await reviewOrgRefusal("org-1", {})).toBeNull()
    expect(await reviewOrgRefusal("org-1", { publish: false, venue: false })).toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("asks the seeded audit row by the organisation's id when it does", async () => {
    expect(await reviewOrgRefusal("org-1", { publish: true })).toBeNull()
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: "razorpay_review.seeded", resource_id: "org-1" } })
    )
  })
})
