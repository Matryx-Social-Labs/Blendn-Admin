/*
 * The staging-only moderation override (SCRUM-479, owner ruling A-13). Staging cannot make the vendor return a real
 * `hide`, so a pull, an auto-mute or a hidden message could never be driven there. MODERATION_FORCE_HIDE_USER_IDS
 * names QA accounts whose every checked message and photo is judged `hide`. Refused on production whatever is set.
 */
jest.mock("@/lib/moderation/actions", () => ({
  hideMessage: jest.fn(),
  flagForReview: jest.fn(),
  checkAndAutoMute: jest.fn(),
  recordExamined: jest.fn(),
}))
jest.mock("@/lib/moderation/openai-moderation", () => ({
  checkTextContent: jest.fn().mockResolvedValue({ checked: true, result: null }),
  checkImageContent: jest.fn().mockResolvedValue({ checked: true, result: null }),
}))
jest.mock("@/lib/tigris", () => ({ readableUrl: jest.fn(async (u: string) => u) }))

import { checkAndAutoMute, hideMessage } from "@/lib/moderation/actions"
import { moderateMessage } from "@/lib/moderation"
import { forcedHide, textCheckFor } from "@/lib/moderation/staging-override"

const ENV = { ...process.env }
afterEach(() => {
  process.env = { ...ENV }
})

const set = (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe("forcedHide", () => {
  it("judges a listed account's content hide on staging", () => {
    set({ RAILWAY_ENVIRONMENT_NAME: "staging", MODERATION_FORCE_HIDE_USER_IDS: "u1, u2" })
    expect(forcedHide("u2")).toMatchObject({ checked: true, result: { action: "hide" } })
    expect(forcedHide("u3")).toBeNull()
  })

  it("never applies on production, whatever is set", () => {
    set({ RAILWAY_ENVIRONMENT_NAME: "production", MODERATION_FORCE_HIDE_USER_IDS: "u1" })
    expect(forcedHide("u1")).toBeNull()
  })

  it("needs the list: unset or blank names nobody", () => {
    set({ RAILWAY_ENVIRONMENT_NAME: "staging", MODERATION_FORCE_HIDE_USER_IDS: undefined })
    expect(forcedHide("u1")).toBeNull()
    set({ MODERATION_FORCE_HIDE_USER_IDS: " , " })
    expect(forcedHide("")).toBeNull()
  })
})

describe("a listed account's chat message", () => {
  it("is hidden and counts toward the auto-mute on staging, through the real path", async () => {
    set({ RAILWAY_ENVIRONMENT_NAME: "staging", MODERATION_FORCE_HIDE_USER_IDS: "qa1" })
    await moderateMessage("m1", "hello there", "text", "qa1", "g1")
    expect(hideMessage).toHaveBeenCalledWith("m1", "g1", "qa1", expect.objectContaining({ action: "hide", source: "openai_text" }))
    expect(checkAndAutoMute).toHaveBeenCalledWith("qa1", "g1")
  })

  it("is left alone on production", async () => {
    jest.clearAllMocks()
    set({ RAILWAY_ENVIRONMENT_NAME: "production", MODERATION_FORCE_HIDE_USER_IDS: "qa1" })
    await moderateMessage("m2", "hello there", "text", "qa1", "g1")
    expect(hideMessage).not.toHaveBeenCalled()
  })
})

// The send routes take the inline verdict first, so without this a forced hide reached only a timed-out check (SCRUM-479 drive: 2 of 4 stayed clean).
describe("textCheckFor", () => {
  const ORIGINAL = process.env.MODERATION_FORCE_HIDE_USER_IDS
  afterEach(() => {
    process.env.MODERATION_FORCE_HIDE_USER_IDS = ORIGINAL
  })

  it("answers a listed user's text with a hide, without asking the vendor", async () => {
    process.env.MODERATION_FORCE_HIDE_USER_IDS = "qa-1"
    const asked = jest.fn()
    const check = await textCheckFor("qa-1", "hello", asked)
    expect(check).toMatchObject({ checked: true, result: { action: "hide", source: "openai_text" } })
    expect(asked).not.toHaveBeenCalled()
  })

  it("asks the vendor for everybody else", async () => {
    process.env.MODERATION_FORCE_HIDE_USER_IDS = "qa-1"
    const verdict = { checked: true, result: null }
    await expect(textCheckFor("someone", "hello", async () => verdict as never)).resolves.toBe(verdict)
  })
})

