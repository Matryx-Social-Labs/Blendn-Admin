import { REPORT_REASONS, reportReason } from "@/lib/report-reasons"

/*
 * The one list of report reasons (D-027, D-032): a severity for the queue's
 * sort and an `urgent` flag the pager reads.
 */

// Every value the installed app sends today (client lib/safetyUtils.ts,
// lib/board.ts, lib/crews.ts, lib/offers.ts on stage and dev).
const INSTALLED = [
  // a person, and Unmatch/Block and report
  "harassment", "inappropriate_messages", "inappropriate_photos", "fake_profile", "spam", "other",
  // a message, and the Lobby
  "hate_speech", "inappropriate_content",
  // an event
  "misleading_listing", "unsafe_venue", "organiser_conduct", "not_real",
  // a room
  "pile_on", "unsafe", "host_conduct",
  // a crew
  "offensive", "contact_details", "impersonation",
  // an offer
  "misleading",
]

describe("report reasons", () => {
  it("knows every value the installed app sends, as itself", () => {
    for (const value of INSTALLED) expect(reportReason(value)).toBe(value)
  })

  it("adds the register's reasons", () => {
    for (const value of ["intimate_image", "impersonation", "under_18", "child_safety", "threat"]) {
      expect(reportReason(value)).toBe(value)
    }
  })

  it("is urgent for exactly the four register reasons", () => {
    const urgent = Object.entries(REPORT_REASONS).filter(([, r]) => r.urgent).map(([v]) => v).sort()
    expect(urgent).toEqual(["child_safety", "impersonation", "intimate_image", "under_18"])
  })

  it("puts threats and the urgent reasons in S1, harassment in S2, spam and other in S3", () => {
    const s1 = Object.entries(REPORT_REASONS).filter(([, r]) => r.severity === "S1").map(([v]) => v).sort()
    expect(s1).toEqual(["child_safety", "impersonation", "intimate_image", "threat", "under_18", "unsafe"])
    expect(REPORT_REASONS.harassment.severity).toBe("S2")
    expect(REPORT_REASONS.spam.severity).toBe("S3")
    expect(REPORT_REASONS.other.severity).toBe("S3")
  })

  it("reads a free string from an older app as other", () => {
    expect(reportReason("He kept messaging me after I said stop")).toBe("other")
    expect(reportReason("")).toBe("other")
    expect(reportReason(null)).toBe("other")
  })

  it("reads case and padding as the value they spell, like the suspension categories", () => {
    expect(reportReason("  Hate_Speech ")).toBe("hate_speech")
    expect(reportReason("UNDER_18")).toBe("under_18")
  })

  it("never reads an inherited property name as a reason", () => {
    for (const value of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(reportReason(value)).toBe("other")
  })
})
