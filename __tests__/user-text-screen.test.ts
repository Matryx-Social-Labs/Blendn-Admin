jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("@/lib/rate-limit-store", () => ({ hit: jest.fn(), forget: jest.fn() }))
import { auditLog } from "@/lib/audit-log"
import { objectionableText, screenUserText, textNotAllowedResponse } from "@/lib/moderation/user-text"

/*
 * The deterministic screen on text strangers read (App Store 1.2). The routes
 * are driven in __tests__/integration/user-text-screening.itest.ts; this pins
 * the rule itself.
 */
beforeEach(() => jest.clearAllMocks())

describe("objectionableText", () => {
  it("refuses a keyword hide and link spam", () => {
    expect(objectionableText("you retard")).toMatchObject({ action: "hide", source: "keyword" })
    expect(objectionableText("https://a.test https://b.test https://c.test")).toMatchObject({ action: "hide", source: "spam" })
  })

  it("lets ordinary text, two links, and a separator-only suspicion through", () => {
    expect(objectionableText("Here for the music and the food.")).toBeNull()
    expect(objectionableText("https://a.test and https://b.test")).toBeNull()
    // Found only once separators are stripped: a suspicion, not a verdict, as in a room.
    // Refusing it would also refuse a name like "Mr. Etard" ("mretard").
    expect(objectionableText("r e t a r d")).toBeNull()
  })
})

describe("screenUserText", () => {
  it("returns the first refused field and audits it without the text", () => {
    expect(screenUserText("u1", "profile", { name: "Asha", bio: "you retard", occupation: "retard" })).toEqual({ field: "bio" })
    expect(auditLog).toHaveBeenCalledTimes(1)
    const entry = (auditLog as jest.Mock).mock.calls[0][0]
    expect(entry).toMatchObject({ userId: "u1", resourceId: "u1", action: "moderation.text_refused", resource: "user" })
    expect(entry.details).toEqual({ surface: "profile", field: "bio", source: "keyword", matched: ["retard"] })
  })

  it("lets an ambiguous name through on identity text and records it as flagged", () => {
    expect(screenUserText("u1", "profile", { name: "Shala Patel", bio: "Sunni Muslim, love chai" })).toBeNull()
    const actions = (auditLog as jest.Mock).mock.calls.map(([e]) => [e.action, e.details.field, e.details.matched])
    expect(actions).toEqual([
      ["moderation.text_flagged", "name", ["shala"]],
      ["moderation.text_flagged", "bio", ["sunni"]],
    ])
  })

  it("holds a message request to the chat rule", () => {
    expect(screenUserText("u1", "message_request", { message: "you magi" })).toEqual({ field: "message" })
  })

  it("skips empty and absent fields, and records nothing when all pass", () => {
    expect(screenUserText("u1", "profile", { name: "Asha", bio: null, occupation: undefined, education: "" })).toBeNull()
    expect(auditLog).not.toHaveBeenCalled()
  })
})

it("answers 400 VALIDATION_FAILED with reasonCode TEXT_NOT_ALLOWED and the field", async () => {
  const res = textNotAllowedResponse("bio", "That can’t go on your profile.")
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    success: false,
    error: "That can’t go on your profile.",
    errorCode: "VALIDATION_FAILED",
    reasonCode: "TEXT_NOT_ALLOWED",
    field: "bio",
    errors: [{ field: "bio", message: "That can’t go on your profile." }],
  })
})
