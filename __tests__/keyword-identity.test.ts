import { CHAT_KEYWORDS, IDENTITY_SLURS, checkIdentityKeywords, checkKeywords } from "@/lib/moderation/keyword-filter"
import { identityTextVerdict } from "@/lib/moderation/user-text"

/*
 * Identity text (a name, a bio, a crew card) is refused only for an
 * unambiguous slur (PR #755 security review, H1). The chat list refused these
 * real names and a faith at sign-up and onboarding.
 */
const REAL_PEOPLE = ["Magi", "Shala Patel", "Bal Krishna", "Boli", "Otha", "Sunni Muslim, love chai"]

it("the identity list is a subset of the chat list", () => {
  expect([...IDENTITY_SLURS].filter((k) => !CHAT_KEYWORDS.has(k))).toEqual([])
})

it.each(REAL_PEOPLE)("%s is allowed on identity text, though the chat list would hide it", (text) => {
  expect(checkKeywords(text)?.action).toBe("hide")
  expect(identityTextVerdict(text)?.action).not.toBe("refuse")
})

it("an ambiguous word is allowed but flagged, naming what matched", () => {
  expect(identityTextVerdict("Sunni Muslim, love chai")).toEqual({
    action: "flag",
    result: expect.objectContaining({ action: "flag", source: "keyword", matched: ["sunni"] }),
  })
})

it("a clear slur is refused, and the refusal names only the slur", () => {
  expect(identityTextVerdict("you retard")).toEqual({ action: "refuse", result: expect.objectContaining({ matched: ["retard"] }) })
  expect(checkIdentityKeywords("Bal the madarchod")).toMatchObject({ action: "hide", matched: ["madarchod"] })
})

it("a slur spelled out to dodge the list is flagged, not refused", () => {
  expect(identityTextVerdict("r e t a r d")?.action).toBe("flag")
})

it("ordinary text says nothing", () => {
  expect(identityTextVerdict("Asha Rao")).toBeNull()
})
