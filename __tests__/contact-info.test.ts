import { readFileSync } from "fs"
import { join } from "path"
import {
  checkContactInfo,
  contactInfoWarning,
  findContactInfo,
} from "@/lib/moderation/contact-info"
import { checkKeywords } from "@/lib/moderation/keyword-filter"

/**
 * Contact details in a pseudonymous room.
 *
 * Two halves, and the second matters more. Catching an obfuscated phone number
 * is satisfying; not firing on "meet me at 9" is what decides whether anybody
 * keeps the feature switched on.
 */

const kinds = (s: string) => findContactInfo(s).map((f) => f.kind)

describe("it catches the obvious", () => {
  it("finds a plain ten-digit number", () => {
    expect(kinds("9876543210")).toContain("phone")
  })

  it("finds one split the way people actually write it", () => {
    expect(kinds("my number is 98765 43210")).toContain("phone")
  })

  it("finds one with separators", () => {
    expect(kinds("call 987-654-3210")).toContain("phone")
  })

  it("finds one spelled out", () => {
    expect(kinds("nine eight seven six five four three")).toContain("phone")
  })
})

describe("it survives the obfuscation the brief named", () => {
  it("reads stretched digit words", () => {
    /*
     * `Nineeee onEe` — the exact shape asked about. This is the case that broke
     * the first implementation: collapsing every run to two letters turns
     * "nineeee" into "ninee", which is not a word the table knows.
     */
    expect(kinds("Nineeee onEe eight seven six five four")).toContain("phone")
  })

  it("reads leetspeak digits", () => {
    expect(kinds("n1ne 0ne 8 7 6 5 4")).toContain("phone")
  })

  it("reads a mix of all three", () => {
    expect(kinds("9 onEe n1ne seveeen 6 5 4")).toContain("phone")
  })

  it("still reads unstretched words the collapse would have broken", () => {
    // "three" collapsed to one letter per run is "thre" — a miss. Both forms
    // have to be tried, and this is the one that proves it.
    expect(kinds("three three three three three three three")).toContain("phone")
  })
})

describe("it does not fire on ordinary talk — the half that decides adoption", () => {
  const innocent = [
    "meet me at 9",
    "see you at 7:30 by the bar",
    "I have 2 tickets and 3 friends coming",
    "table 12, upstairs",
    "the set starts in 20 minutes",
    "grab 4 beers, I'll pay",
    "it's 500 for entry",
    "we're 6 people",
    "I'll be there for one hour, maybe two",
    "that was the best gig of 2026",
  ]

  it.each(innocent)("stays quiet on %p", (text) => {
    expect(findContactInfo(text)).toEqual([])
  })

  it("does not treat @mentions as handles", () => {
    /*
     * `@word` is how people address each other. A rule keyed on it would fire
     * constantly on a room working exactly as intended, which is why the
     * detector keys on the *platform name* instead.
     */
    expect(findContactInfo("@priya you coming or what")).toEqual([])
  })

  it("does not read a sentence of function words as a number", () => {
    // "to", "for", "won", "ate" are in the digit table because dictated numbers
    // use them. Prose has other words between, which break the run.
    expect(findContactInfo("I went to the bar for a bit and ate too much")).toEqual([])
  })
})

describe("handles and links", () => {
  it("flags a named platform", () => {
    expect(kinds("add me on insta, same name")).toContain("handle")
  })

  it("flags a direct-message link", () => {
    expect(kinds("https://wa.me/919876543210")).toContain("link")
  })

  it("reports every kind it finds, not just the first", () => {
    const found = kinds("insta is @foo, number 9876543210")
    expect(found).toContain("handle")
    expect(found).toContain("phone")
  })
})

describe("the verdict, per surface", () => {
  it("hides in a room, and carries the flag so a moderator can restore", () => {
    /*
     * Decided 2026-09-12 after a drive showed a seeded phone number sitting in
     * a live room for hours. The old design ("never hides — a block teaches
     * the boundary and empties the flag stream") kept the evasion argument;
     * this keeps the flag, and loses only the message that was hidden.
     */
    const result = checkContactInfo("9876543210 add me on insta wa.me/1")
    expect(result?.action).toBe("hide")
    expect(result?.categories).toMatchObject({ contact_phone: 1, contact_handle: 1, contact_link: 1 })
  })

  it("is decided before the row is written, on both send routes", () => {
    /*
     * A hide that happens after the emit is a number the room already saw.
     * `preSaveCheck` composes keywords and contact details and both routes
     * call it instead of `checkKeywords` directly — with `autoMute: false`
     * for contact details, since sharing your own number is not abuse.
     */
    const pipeline = readFileSync(join(process.cwd(), "lib/moderation/index.ts"), "utf8")
    expect(pipeline).toMatch(/export function preSaveCheck/)
    expect(pipeline).toMatch(/contact && contact\.action === "hide"\) return \{ result: contact, autoMute: false \}/)
    for (const route of [
      "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
      "app/api/mobile/events/[eventId]/chat/route.ts",
    ]) {
      const src = readFileSync(join(process.cwd(), route), "utf8")
      expect(src).toMatch(/const preSave = preSaveCheck\(content\)/)
      expect(src).not.toMatch(/checkKeywords\(content\)/)
      expect(src).toMatch(/if \(preSave\.autoMute\) void checkAndAutoMute/)
    }
  })

  it("the DM path reads it as a yes/no and lets the message through", () => {
    const dm = readFileSync(join(process.cwd(), "lib/dm-moderation.ts"), "utf8")
    expect(dm).toMatch(/if \(checkContactInfo\(text\)\) return \{ verdict: "allow", status: "flagged" \}/)
  })

  it("returns null for clean text rather than an allow verdict", () => {
    // So the caller can skip the flag write entirely.
    expect(checkContactInfo("great set tonight")).toBeNull()
  })

  it("tells the sender what will happen, not what is forbidden", () => {
    const warning = contactInfoWarning(findContactInfo("9876543210"))
    expect(warning).toContain("removed before anyone sees it")
    expect(warning).toContain("anonymous")
    expect(warning).not.toContain("Send anyway")
  })

  it("has no warning when there is nothing to warn about", () => {
    expect(contactInfoWarning(findContactInfo("hello"))).toBeNull()
  })
})

describe("this is not a profanity filter, and must not become one", () => {
  const allowed = [
    "fuck the party was good",
    "amazing fucking event",
    "that DJ was shit hot",
    "bloody brilliant night",
  ]

  it.each(allowed)("leaves %p alone in both layers", (text) => {
    /*
     * The distinction the whole moderation design rests on: profanity is a
     * property of a word, harassment is a property of a relationship. The
     * keyword list is a *slur* list for exactly this reason — it contains no
     * plain profanity — and this detector has no opinion about words at all.
     */
    expect(findContactInfo(text)).toEqual([])
    // `checkKeywords` returns null for clean text rather than an allow verdict.
    expect(checkKeywords(text)).toBeNull()
  })
})

describe("known limits, recorded rather than papered over", () => {
  it("does not attempt addresses", () => {
    /*
     * "Meet at the Blue Door on MG Road" is an address and is also exactly what
     * an event chat is for. There is no version of that rule that does not fire
     * on the product's main use case.
     */
    expect(findContactInfo("meet at the Blue Door on MG Road")).toEqual([])
  })

  it("cannot tell whose number it is", () => {
    // Doxxing and self-disclosure are the same string. The nudge is addressed
    // to the sender either way; the report button is the remedy for the first.
    expect(kinds("her number is 9876543210")).toEqual(kinds("my number is 9876543210"))
  })

  it("fires on a fully spelled date, which is accepted", () => {
    // "16 08 2026" is eight digits and reads as a number. Acceptable precisely
    // because the response is a warning: the cost of being wrong is one tap.
    expect(kinds("16 08 2026")).toContain("phone")
  })
})
