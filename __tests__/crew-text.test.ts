jest.mock("@/lib/db", () => ({ db: {} }))
/*
 * OpenAI as it behaved on staging (client #544 drive): `fuckoff` alone is
 * hidden; inside a longer text its score is diluted and it passes. Everything
 * else is looked at and clean.
 */
jest.mock("@/lib/moderation/openai-moderation", () => ({
  checkTextContents: jest.fn(async (texts: string[]) =>
    texts.map((t) => ({
      checked: true,
      result: t === "fuckoff" ? { action: "hide", source: "openai_text", categories: { harassment: 0.9 }, confidence: 0.9 } : null,
    }))
  ),
  notChecked: (reason: string) => ({ checked: false, reason }),
}))

import { findProfileContactInfo, findContactInfo } from "@/lib/moderation/contact-info"
import { foldText, hasInvisibleChars } from "@/lib/moderation/fold"
import { CREW_TAG_IDEAS, createCrewSchema, crewTextRefusal, inviteSchema, tagView, updateCrewSchema } from "@/lib/crews/crews"
import { characters } from "@/lib/utils"
import { CREW } from "@/lib/constants"
import { checkTextContents } from "@/lib/moderation/openai-moderation"

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

  it("is stricter than the room’s reading, never looser", () => {
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
    expect((await crewTextRefusal("bio", "dm us @thelot"))?.refusal).toMatch(/social media handle.*contact details can’t go on it/)
    expect((await crewTextRefusal("name", "Lot 98450 12345"))?.refusal).toMatch(/phone number/)
  })

  it("says nothing about the filter for a banned word", async () => {
    expect((await crewTextRefusal("name", "retard squad"))?.refusal).toBe("This can’t be a crew’s name.")
  })

  it("lets an ordinary name through, and a duplicate one — names are not unique", async () => {
    expect(await crewTextRefusal("name", "Saturday Lot")).toBeNull()
    expect(await crewTextRefusal("name", "Saturday Lot")).toBeNull()
  })
})

describe("a crew’s shape (CR-U01)", () => {
  const base = { revealConsent: true as const, inviteUserIds: [] }

  it("a name is 2–32 characters, counted as a person counts them", () => {
    expect(createCrewSchema.safeParse({ ...base, name: "A" }).success).toBe(false)
    expect(createCrewSchema.safeParse({ ...base, name: "Ab" }).success).toBe(true)
    expect(createCrewSchema.safeParse({ ...base, name: "x".repeat(33) }).success).toBe(false)
    // An emoji is one character, as Postgres's char_length counts it.
    expect(characters("🔥🔥")).toBe(2)
    expect(createCrewSchema.safeParse({ ...base, name: "🔥🔥" }).success).toBe(true)
  })

  it("a bio is at most 140", () => {
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", bio: "x".repeat(140) }).success).toBe(true)
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", bio: "x".repeat(141) }).success).toBe(false)
  })

  it("an emblem seed is optional, and when sent is exactly 16 lowercase hex characters (Shuffle at Make)", () => {
    const ok = (emblemSeed: unknown) => createCrewSchema.safeParse({ ...base, name: "Lot", emblemSeed }).success
    expect(createCrewSchema.safeParse({ ...base, name: "Lot" }).success).toBe(true)
    expect(ok("0123456789abcdef")).toBe(true)
    expect(createCrewSchema.parse({ ...base, name: "Lot", emblemSeed: "0123456789abcdef" }).emblemSeed).toBe("0123456789abcdef")
    for (const bad of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "0123456789abcdeg", " 0123456789abcde", "", 12, null]) {
      expect(ok(bad)).toBe(false)
    }
  })

  it("joining needs the reveal consent, said in so many words", () => {
    expect(createCrewSchema.safeParse({ name: "Lot" }).success).toBe(false)
    expect(createCrewSchema.safeParse({ name: "Lot", revealConsent: false }).success).toBe(false)
  })

  it("at most 24 invitees with the creator: a crew of 25 (owner 2026-11-14), and the old 12 still fits", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`)
    expect(CREW.MAX_MEMBERS).toBe(25)
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", inviteUserIds: ids(24) }).success).toBe(true)
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", inviteUserIds: ids(25) }).success).toBe(false)
    expect(inviteSchema.safeParse({ userIds: ids(24) }).success).toBe(true)
    expect(inviteSchema.safeParse({ userIds: ids(25) }).success).toBe(false)
    // Control: a crew of 12, the old ceiling, is still a crew.
    expect(createCrewSchema.safeParse({ ...base, name: "Lot", inviteUserIds: ids(11) }).success).toBe(true)
  })

  it("keeps the solo guard at 6: a crew of 7 or more never matches one person (safety, not size)", () => {
    expect(CREW.MAX_SOLO_MATCH).toBe(6)
  })
})

describe("folded before any check reads it, and stored folded (C12)", () => {
  /*
   * Each of these walked past the checks before folding (PR #630 security
   * review): a reader sees a phone number, a handle or an address; the code
   * points said otherwise.
   */
  it.each([
    ["fullwidth digits", "call ９８４５０ １２３４５", "call 98450 12345"],
    ["Devanagari digits", "call ९८४५० १२३४५", "call 98450 12345"],
    ["Bengali digits", "৯৮৪৫০ ১২৩৪৫", "98450 12345"],
    ["mathematical digits", "𝟗𝟖𝟒𝟓𝟎 𝟏𝟐𝟑𝟒𝟓", "98450 12345"],
    ["a zero-width space after the @", "find us @​thelot", "find us @thelot"],
    ["Cyrillic look-alikes", "рriya аt gmаil dоt cоm", "priya at gmail dot com"],
    ["U+2024 for a dot", "thelot․in", "thelot.in"],
    ["a right-to-left override", "‮54321 05489", "54321 05489"],
  ])("%s", (_label, text, folded) => {
    expect(foldText(text)).toBe(folded)
    // And the folded text is what the contact check reads.
    expect(findProfileContactInfo(foldText(text)).length).toBeGreaterThan(0)
  })

  it("leaves ordinary text, and emoji spelled with a joiner, as they are", () => {
    for (const text of ["Saturday Lot", "Ee sala cup namdu 🏏", "Café Crew", "👯‍♀️ dance floor", "🏳️‍🌈 pride"]) {
      expect(foldText(text)).toBe(text.normalize("NFKC"))
      expect(hasInvisibleChars(text)).toBe(false)
    }
  })

  const base = { revealConsent: true as const, inviteUserIds: [] }

  it("refuses a name with an invisible character, and stores a name folded", () => {
    expect(createCrewSchema.safeParse({ ...base, name: "Lot​​" }).success).toBe(false)
    expect(createCrewSchema.safeParse({ ...base, name: "‮toL" }).success).toBe(false)
    const parsed = createCrewSchema.parse({ ...base, name: "Ｓａｔｕｒｄａｙ  Lоt" })
    expect(parsed.name).toBe("Saturday Lot")
  })

  it("strips invisible characters from a bio rather than refusing it", () => {
    const parsed = createCrewSchema.parse({ ...base, name: "Lot", bio: "quiz​ nights ९" })
    expect(parsed.bio).toBe("quiz nights 9")
  })
})

describe("a crew’s own hashtags (owner pick A, 2026-11-14)", () => {
  const base = { revealConsent: true as const, inviteUserIds: [], name: "Lot" }
  const tags = (t: unknown) => {
    const r = createCrewSchema.safeParse({ ...base, tags: t })
    return r.success ? r.data.tags : null
  }

  it("strips the #, trims, closes up spaces, and keeps the case as typed", () => {
    expect(tags(["#RunClub", "  # late  night ", "##Chai", "dosaAfter"])).toEqual(["RunClub", "latenight", "Chai", "dosaAfter"])
  })

  it("dedupes case-folded, keeping the first one’s case", () => {
    expect(tags(["#RunClub", "runclub", "RUNCLUB", "#Chai"])).toEqual(["RunClub", "Chai"])
  })

  it("takes up to 5, each up to 24 characters (an emoji is one)", () => {
    expect(CREW.MAX_TAGS).toBe(5)
    expect(CREW.TAG_MAX).toBe(24)
    expect(tags(["a1", "b2", "c3", "d4", "e5"])).toHaveLength(5)
    expect(tags(["a1", "b2", "c3", "d4", "e5", "f6"])).toBeNull()
    expect(tags(["x".repeat(24)])).toEqual(["x".repeat(24)])
    expect(tags(["#" + "x".repeat(24)])).toEqual(["x".repeat(24)])
    expect(tags(["x".repeat(25)])).toBeNull()
    expect(tags(["🔥".repeat(24)])).toEqual(["🔥".repeat(24)])
    expect(tags(["🔥".repeat(25)])).toBeNull()
  })

  it("refuses an empty tag", () => {
    for (const bad of ["", "#", "  # ", "##"]) expect(tags([bad])).toBeNull()
  })

  it("accepts any script’s letters and digits, _ and emoji", () => {
    const hindi = foldText("कैफ़ेहॉपिंग")
    expect(tags(["#कैफ़ेहॉपिंग"])).toEqual([hindi])
    expect(tags(["chai🍵", "👯‍♀️", "🇮🇳", "late_night", "東京"])).toEqual(["chai🍵", "👯‍♀️", "🇮🇳", "late_night", "東京"])
    // Folded as a name is: look-alike Cyrillic reads as Latin, as the checks and the screen see it.
    expect(tags(["Москва", "café", "24x7", "1️⃣"])).toEqual([foldText("Москва"), "café", "24x7", "1️⃣"])
  })

  it("refuses links, @handles and e-mails by their characters", () => {
    for (const bad of ["@thelot", "thelot.in", "instagram.com/thelot", "a@b.co", "http://x", "run-club-now", "dm:me", "+919845012345"]) {
      expect(tags([bad])).toBeNull()
    }
  })

  it("still takes the ten old slugs as they are, and shows them by their label", () => {
    expect(tags(["quiz-team", "run-club", "foodies"])).toEqual(["quiz-team", "run-club", "foodies"])
    expect(tagView(["quiz-team", "RunClub", "कैफ़े"])).toEqual([
      { slug: "quiz-team", label: "Quiz team" },
      { slug: "runclub", label: "RunClub" },
      { slug: "कैफ़े", label: "कैफ़े" },
    ])
  })

  it("offers the old slugs as ideas, each one a tag the schema takes as it is", () => {
    expect(CREW_TAG_IDEAS).toEqual([
      "quizteam", "runclub", "technoheads", "officegang", "birthdaycrew", "foodies", "boardgamers", "giggoers", "bookclub", "dancefloor",
    ])
    for (const idea of CREW_TAG_IDEAS) expect(tags([idea])).toEqual([idea])
  })

  it("an edit takes the same tags", () => {
    expect(updateCrewSchema.parse({ tags: ["#RunClub", "runclub"] }).tags).toEqual(["RunClub"])
    expect(updateCrewSchema.safeParse({ tags: ["@thelot"] }).success).toBe(false)
  })

  it("moderates each tag on its own, so a bad one among clean ones is not diluted (client #544 drive)", async () => {
    // The control: the mock hides `fuckoff` only when it is read alone, as OpenAI did.
    expect((await crewTextRefusal("tags", ["fuckoff"]))?.refusal).toBe("This can’t be a crew’s tag.")
    for (const tags of [["sundayrunclub", "fuckoff"], ["fuckoff", "sundayrunclub"], ["a1", "b2", "fuckoff", "c3", "d4"]]) {
      expect(await crewTextRefusal("tags", tags)).toMatchObject({ refusal: "This can’t be a crew’s tag.", tag: "fuckoff" })
    }
    // A slur in any position, by the keyword list.
    for (const tags of [["retard", "fun"], ["fun", "retard"], ["a", "retard", "b"]]) {
      expect(await crewTextRefusal("tags", tags)).toMatchObject({ refusal: "This can’t be a crew’s tag.", tag: "retard" })
    }
  })

  it("asks OpenAI once for all the tags, each on its own and all together", async () => {
    const asked = checkTextContents as jest.Mock
    asked.mockClear()
    await crewTextRefusal("tags", ["sundayrunclub", "dosaafter", "chai"])
    expect(asked).toHaveBeenCalledTimes(1)
    expect(asked).toHaveBeenCalledWith(["sundayrunclub", "dosaafter", "chai", "sundayrunclub dosaafter chai"])
  })

  it("reads tags against the crew-name keyword list: `bc` is British Columbia (owner 2026-11-14)", async () => {
    expect(await crewTextRefusal("tags", ["bc"])).toBeNull()
    expect(await crewTextRefusal("tags", ["vancouver", "bc"])).toBeNull()
    expect(await crewTextRefusal("name", "bc squad")).toBeNull()
  })

  it("refuses contact details in one tag, and split across tags", async () => {
    expect((await crewTextRefusal("tags", ["call", "9845012345"]))?.refusal).toMatch(/phone number.*contact details can’t go on it/)
    expect((await crewTextRefusal("tags", ["98450", "12345"]))?.refusal).toMatch(/phone number/)
    // Split across tags, no one tag is to blame.
    expect((await crewTextRefusal("tags", ["98450", "12345"]))?.tag).toBeUndefined()
    // Keycap digits are allowed in a tag, and still read as a number.
    const keycaps = (d: string) => [...d].map((c) => `${c}\uFE0F\u20E3`).join("")
    expect((await crewTextRefusal("tags", [keycaps("98450"), keycaps("12345")]))?.refusal).toMatch(/phone number/)
  })

  it("lets ordinary tags through (the control)", async () => {
    expect(await crewTextRefusal("tags", ["sundayrunclub", "dosaafter", "कैफ़ेहॉपिंग", "chai🍵", "quiz-team"])).toBeNull()
    expect(await crewTextRefusal("tags", ["sundayrunclub"])).toBeNull()
  })
})
