/**
 * What a suspended person is told (SCRUM-1174): a fixed category and where to
 * appeal, and only to the account's owner. A refusal with no proven owner keeps
 * the generic sentence, so no response tells a stranger why someone was
 * suspended; staff's notes and a reporter's words are never echoed.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { accountRefusal, suspendedMessageFor } from "@/lib/account-refusal"
import { COMPANY } from "@/lib/company"
import { SUSPENDED_MESSAGE } from "@/lib/mobile-auth"
import { REPORT_REASONS } from "@/lib/report-reasons"
import { SUSPENSION_CATEGORIES, suspensionCategory } from "@/lib/suspension"

const GRIEVANCE = COMPANY.grievance.email

describe("suspensionCategory: a report's reason, as one of a fixed list", () => {
  it.each([
    ["harassment", "harassment"],
    ["  Hate_Speech ", "hate_speech"],
    ["spam", "spam"],
    ["fake_profile", "fake_profile"],
    ["inappropriate_photos", "inappropriate_photos"],
  ])("%j is %j", (reason, category) => {
    expect(suspensionCategory(reason)).toBe(category)
  })

  it.each(["other", "they were rude to me at the bar", "", null, undefined, "__proto__", "toString"])(
    "%j is guidelines",
    (reason) => {
      expect(suspensionCategory(reason)).toBe("guidelines")
    }
  )
})

describe("suspendedMessageFor: the sentence the owner reads", () => {
  it("names the category and the appeal address, after the title the app splits off", () => {
    const m = suspendedMessageFor("harassment")
    expect(m).toBe(`This account has been suspended. Reason: harassment. To appeal, write to ${GRIEVANCE}.`)
  })

  it("says community guidelines when there is no category", () => {
    expect(suspendedMessageFor(null)).toBe(
      `This account has been suspended. Reason: breaking our community guidelines. To appeal, write to ${GRIEVANCE}.`
    )
  })

  it("never echoes free text: a moderator's note reads as community guidelines", () => {
    const m = suspendedMessageFor("private moderator note")
    expect(m).not.toContain("private moderator note")
    expect(m).toBe(suspendedMessageFor(null))
  })

  it("starts with the sentence installed apps classify on", () => {
    expect(suspendedMessageFor("spam").startsWith("This account has been suspended")).toBe(true)
  })
})

describe("accountRefusal: the reason only reaches a proven owner", () => {
  it("with no owner, the generic sentence and today's shape", async () => {
    const res = accountRefusal("suspended")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      success: false,
      error: SUSPENDED_MESSAGE,
      errorCode: "FORBIDDEN",
      reasonCode: "ACCOUNT_SUSPENDED",
    })
  })

  it("with the owner, the category and appeal address; status and codes unchanged", async () => {
    const res = accountRefusal("suspended", { suspension_reason: "harassment" })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      success: false,
      error: suspendedMessageFor("harassment"),
      errorCode: "FORBIDDEN",
      reasonCode: "ACCOUNT_SUSPENDED",
    })
  })

  it("a staff refusal is unchanged by an owner", async () => {
    const a = await accountRefusal("staff").json()
    const b = await accountRefusal("staff", { suspension_reason: "harassment" }).json()
    expect(b).toEqual(a)
  })
})

describe("the categories are the report reasons, read from one list", () => {
  it("every category but guidelines is a report reason", () => {
    const extra = Object.keys(SUSPENSION_CATEGORIES).filter((k) => k !== "guidelines" && !Object.hasOwn(REPORT_REASONS, k))
    expect(extra).toEqual([])
  })

  it("a reason's suspension phrase is what its owner reads; a reason without one reads as guidelines", () => {
    for (const [value, r] of Object.entries(REPORT_REASONS)) {
      const reads = r.suspension ? `This account has been suspended. Reason: ${r.suspension}. To appeal, write to ${GRIEVANCE}.` : suspendedMessageFor(null)
      expect(suspendedMessageFor(value)).toBe(reads)
    }
  })

  it("the phrases read word for word as they did", () => {
    expect(SUSPENSION_CATEGORIES).toEqual({
      harassment: "harassment",
      hate_speech: "hate speech",
      spam: "spam",
      fake_profile: "a fake profile",
      inappropriate_messages: "inappropriate messages",
      inappropriate_photos: "inappropriate photos",
      inappropriate_content: "inappropriate content",
      guidelines: "breaking our community guidelines",
    })
  })
})
