jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/moderation/openai-moderation", () => ({
  checkTextContent: jest.fn(async () => ({ checked: false, reason: "no_key" })),
  notChecked: (reason: string) => ({ checked: false, reason }),
}))

import { findProfileContactInfo, findContactInfo } from "@/lib/moderation/contact-info"
import { characters, createCrewSchema, crewTextRefusal } from "@/lib/crews/crews"
import { CREW } from "@/lib/constants"

/**
 * A crew's name and bio (CR-U01, CR-U02).
 *
 * The card they are on is shown to strangers every night out, so contact
 * details are refused in the strict reading a card gets — and the half that
 * decides whether the feature survives is the other one: ordinary crew names
 * and bios pass.
 */

const kinds = (s: string) => findProfileContactInfo(s).map((f) => f.kind)

describe("contact details in a name or bio are found, written out or spelled", () => {
  it.each([
    ["call 98450 12345", "phone"],
    ["nine eight four five six seven three two", "phone"],
    ["@insta_handle", "handle"],
    ["find us @thesaturdaylot", "handle"],
    ["snap: thelot", "handle"],
    ["priya.k@gmail.com", "email"],
    ["priya at gmail dot com", "email"],
    ["write to us (at) lotmail (dot) com", "email"],
    ["www.saturdaylot.in", "url"],
    ["saturdaylot.com", "url"],
    ["https://lot.example/join", "url"],
    ["the lot dot in", "url"],
    ["wa.me/919845012345", "link"],
  ])("%s → %s", (text, kind) => {
    expect(kinds(text)).toContain(kind)
  })
})

describe("ordinary crews pass", () => {
  it.each([
    "Saturday Lot",
    "The Usual Suspects",
    "Quiz night regulars since 2019",
    "Live music, positive outlook",
    "We meet @ 9 by the bar",
    "Board games & chai",
    "Est. in 2021, still undefeated",
    "Ee sala cup namdu 🏏",
    "Five of us, one dance floor",
  ])("%s", (text) => {
    expect(findProfileContactInfo(text)).toEqual([])
  })

  it("is stricter than the room's reading, never looser", () => {
    // Whatever a room would hide, a card refuses.
    for (const text of ["9876543210", "insta: priya", "t.me/priya"]) {
      expect(findContactInfo(text).length).toBeGreaterThan(0)
      expect(findProfileContactInfo(text).length).toBeGreaterThan(0)
    }
    // And a handle in conversation, which a room lets through, a card does not.
    expect(findContactInfo("@priya you coming?")).toEqual([])
    expect(kinds("@priya you coming?")).toContain("handle")
  })
})

describe("the refusal a writer is given", () => {
  it("names the contact detail, so the fix is theirs to make", async () => {
    expect(await crewTextRefusal("bio", "dm us @thelot")).toMatch(/social media handle.*contact details can't go on it/)
    expect(await crewTextRefusal("name", "Lot 98450 12345")).toMatch(/phone number/)
  })

  it("says nothing about the filter for a banned word", async () => {
    expect(await crewTextRefusal("name", "retard squad")).toBe("This can't be a crew's name.")
  })

  it("lets an ordinary name through, and a duplicate one — names are not unique", async () => {
    expect(await crewTextRefusal("name", "Saturday Lot")).toBeNull()
    expect(await crewTextRefusal("name", "Saturday Lot")).toBeNull()
  })
})

describe("a crew's shape (CR-U01)", () => {
  const base = { revealConsent: true as const, inviteUserIds: [] }

  it("a name is 2–32 characters, counted as a person counts them", () => {
    expect(createCrewSchema.safeParse({ ...base, name: "A" }).success).toBe(false)
    expect(createCrewSchema.safeParse({ ...base, name: "Ab" }).success).toBe(true)
    expect(createCrewSchema.safeParse({ ...base, name: "x".repeat(33) }).success).toBe(false)
    // An emoji is one character, as Postgres's char_length counts it.
    expect(characters("🔥🔥")).toBe(2)
    expect(createCrewSchema.safeParse({ ...base, name: "🔥🔥" }).success).toBe(true)
  })

  it("a bio is at most 140, tags are curated and at most 3", () => {
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", bio: "x".repeat(141) }).success).toBe(false)
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", tags: ["quiz-team", "run-club", "foodies"] }).success).toBe(true)
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", tags: ["quiz-team", "run-club", "foodies", "book-club"] }).success).toBe(false)
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", tags: ["anything we like"] }).success).toBe(false)
  })

  it("joining needs the reveal consent, said in so many words", () => {
    expect(createCrewSchema.safeParse({ name: "Lot" }).success).toBe(false)
    expect(createCrewSchema.safeParse({ name: "Lot", revealConsent: false }).success).toBe(false)
  })

  it("at most 11 invitees with the creator: a crew of 12", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`)
    expect(CREW.MAX_MEMBERS).toBe(12)
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", inviteUserIds: ids(11) }).success).toBe(true)
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", inviteUserIds: ids(12) }).success).toBe(false)
  })
})
