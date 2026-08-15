import {
  ORIENTATIONS,
  deriveInterestedIn,
  isOrientation,
  matchCompatibleForDating,
  orientationsAreCoherent,
  type Gender,
  type Orientation,
} from "@/lib/dating"
import { rankMatches, type Intent, type MatchCandidate } from "@/lib/matching"

/**
 * Dating compatibility: a tag filter, and a table that knows what it does not know.
 *
 * `lib/matches.ts` never read gender at all, so a straight man who ticked
 * dating got "Both open to dating" on cards for other straight men. The fix has
 * to be careful in two directions at once — it must stop claiming matches that
 * are not matches, and it must not start guessing about people whose
 * orientation label does not imply a target set.
 */

describe("deriveInterestedIn — the pairs that mean something", () => {
  const cases: Array<[Gender, Orientation, Gender[]]> = [
    ["woman", "straight", ["man"]],
    ["man", "straight", ["woman"]],
    ["man", "gay", ["man"]],
    ["woman", "gay", ["woman"]],
    ["woman", "lesbian", ["woman"]],
    ["woman", "bisexual", ["woman", "man", "non_binary"]],
    ["man", "bisexual", ["woman", "man", "non_binary"]],
    ["non_binary", "bisexual", ["woman", "man", "non_binary"]],
  ]

  it.each(cases)("%s + %s → %s", (gender, orientation, expected) => {
    expect(deriveInterestedIn(gender, [orientation])).toEqual(expected)
  })

  it("treats asexual as a complete answer, not a missing one", () => {
    // An empty set, not null. Someone asexual who ticked dating is looking for
    // something these tags do not model, and "no dating tag" is the honest
    // outcome rather than a prompt to answer a question again.
    expect(deriveInterestedIn("woman", ["asexual"])).toEqual([])
  })
})

/*
 * More than one label, because people hold more than one.
 *
 * The single column made someone pick which part of themselves to omit. What
 * replaced it has two properties worth pinning, and they pull in opposite
 * directions: a second label must never *narrow* the result, and a second label
 * that means nothing definite must not be quietly dropped.
 */
describe("deriveInterestedIn — more than one label", () => {
  it("unions rather than intersects", () => {
    // The whole reason multi-select is safe. Intersecting would leave a lesbian
    // bisexual woman with ["woman"] — narrower than either label alone implies,
    // which is the opposite of what picking both says.
    expect(deriveInterestedIn("woman", ["lesbian", "bisexual"])).toEqual([
      "woman",
      "man",
      "non_binary",
    ])
  })

  it("keeps a biromantic asexual person's romantic set", () => {
    // The case that proves union is the right operator and not merely the
    // generous one: `asexual` derives [] on its own, and an intersection would
    // delete a real, common combination of labels down to nobody.
    expect(deriveInterestedIn("man", ["asexual", "bisexual"])).toEqual([
      "woman",
      "man",
      "non_binary",
    ])
  })

  it("returns null when any single label is one it cannot read", () => {
    /*
     * Null has always meant *ask*, never *assume*, so one unknown makes the
     * whole answer unknown.
     *
     * The alternative — union the ones that resolved, ignore the nulls — fails
     * in the one direction that matters. This woman would derive from
     * "straight" alone and be pinned to ["man"], having just told us in her
     * second label that this is not the whole picture. An extra question is a
     * screen; being narrowed on an assumption is the bug this file exists to
     * avoid.
     */
    expect(deriveInterestedIn("woman", ["straight", "queer"])).toBeNull()
    expect(deriveInterestedIn("man", ["bisexual", "pansexual"])).toBeNull()
  })

  it("reads an empty list as nothing declared", () => {
    expect(deriveInterestedIn("woman", [])).toBeNull()
  })

  it("returns the same array whatever order the labels arrive in", () => {
    // Stored, compared and asserted on, so insertion order cannot decide it.
    expect(deriveInterestedIn("woman", ["lesbian", "bisexual"])).toEqual(
      deriveInterestedIn("woman", ["bisexual", "lesbian"])
    )
  })
})

describe("orientationsAreCoherent", () => {
  it("accepts up to three distinct recognised labels", () => {
    expect(orientationsAreCoherent([])).toBe(true)
    expect(orientationsAreCoherent(["queer"])).toBe(true)
    expect(orientationsAreCoherent(["queer", "bisexual", "asexual"])).toBe(true)
  })

  it("refuses a fourth", () => {
    expect(orientationsAreCoherent(["queer", "bisexual", "asexual", "pansexual"])).toBe(false)
  })

  it("refuses duplicates", () => {
    // Otherwise the cap is three *slots*, not three answers, and ["gay","gay"]
    // stores a set of one while looking like a set of two.
    expect(orientationsAreCoherent(["gay", "gay"])).toBe(false)
  })

  it("refuses prefer_not_to_say beside anything else", () => {
    // The same rule `intentsAreCoherent` applies to `just_here`: declining to
    // answer is not a fourth thing you are, so this pair is two contradictory
    // statements and the server should not have to pick one.
    expect(orientationsAreCoherent(["prefer_not_to_say"])).toBe(true)
    expect(orientationsAreCoherent(["prefer_not_to_say", "gay"])).toBe(false)
  })

  it("refuses a label it does not recognise", () => {
    expect(orientationsAreCoherent(["demisexual"])).toBe(false)
    expect(orientationsAreCoherent(["Bisexual"])).toBe(false)
  })
})

describe("deriveInterestedIn — the pairs that do not", () => {
  it("refuses to guess for a non-binary person labelled straight or gay", () => {
    // "Straight" is defined relative to a binary they are not in. Every
    // implementation that answers this is inventing someone's dating life.
    expect(deriveInterestedIn("non_binary", ["straight"])).toBeNull()
    expect(deriveInterestedIn("non_binary", ["gay"])).toBeNull()
  })

  it("refuses to guess for identity labels that are not target sets", () => {
    expect(deriveInterestedIn("woman", ["pansexual"])).toBeNull()
    expect(deriveInterestedIn("man", ["queer"])).toBeNull()
  })

  it("refuses to guess from prefer_not_to_say, in either position", () => {
    // Someone may want the label on their profile without it implying anything
    // about who they want to meet.
    expect(deriveInterestedIn("woman", ["prefer_not_to_say"])).toBeNull()
    expect(deriveInterestedIn("prefer_not_to_say", ["straight"])).toBeNull()
  })

  it("returns null when either half is missing", () => {
    expect(deriveInterestedIn(null, ["straight"])).toBeNull()
    expect(deriveInterestedIn("woman", null)).toBeNull()
    expect(deriveInterestedIn(null, null)).toBeNull()
  })

  it("has an answer, null or otherwise, for every declared combination", () => {
    // Guards against a label being added to `ORIENTATIONS` and falling through
    // the switch into `undefined`, which is neither a set nor a prompt to ask.
    const genders: Gender[] = ["woman", "man", "non_binary", "prefer_not_to_say"]
    for (const g of genders) {
      for (const o of ORIENTATIONS) {
        const result = deriveInterestedIn(g, [o])
        expect(result === null || Array.isArray(result)).toBe(true)
      }
    }
  })

  it("recognises its own labels and nothing else", () => {
    expect(isOrientation("bisexual")).toBe(true)
    expect(isOrientation("Bisexual")).toBe(false)
    expect(isOrientation("heterosexual")).toBe(false)
    expect(isOrientation(null)).toBe(false)
  })
})

describe("matchCompatibleForDating is mutual and fails closed", () => {
  const straightMan = { gender: "man" as Gender, interestedIn: ["woman"] as Gender[] }
  const straightWoman = { gender: "woman" as Gender, interestedIn: ["man"] as Gender[] }
  const gayMan = { gender: "man" as Gender, interestedIn: ["man"] as Gender[] }
  const bi = { gender: "woman" as Gender, interestedIn: ["woman", "man"] as Gender[] }

  it("matches a straight man and a straight woman", () => {
    expect(matchCompatibleForDating(straightMan, straightWoman)).toBe(true)
    expect(matchCompatibleForDating(straightWoman, straightMan)).toBe(true)
  })

  it("does not match two straight men", () => {
    expect(matchCompatibleForDating(straightMan, { ...straightMan })).toBe(false)
  })

  it("matches two gay men", () => {
    expect(matchCompatibleForDating(gayMan, { ...gayMan })).toBe(true)
  })

  it("requires both directions", () => {
    // A bisexual woman is open to a straight woman; the straight woman is not
    // open to her. One-sided would put "Both open to dating" on a card where
    // only one person means it.
    const straightWomanB = { gender: "woman" as Gender, interestedIn: ["man"] as Gender[] }
    expect(matchCompatibleForDating(bi, straightWomanB)).toBe(false)
  })

  it("fails closed on a missing gender", () => {
    expect(matchCompatibleForDating({ gender: null, interestedIn: ["man"] }, straightWoman)).toBe(
      false
    )
  })

  it("fails closed on an empty interestedIn", () => {
    // Which is also the asexual case, and reads the same: there is no evidence
    // of a match, and the tag is the thing being claimed.
    expect(matchCompatibleForDating({ gender: "man", interestedIn: [] }, straightWoman)).toBe(false)
  })
})

describe("the ranking drops the tag, never the person", () => {
  const candidate = (over: Partial<MatchCandidate> & { userId: string }): MatchCandidate => ({
    pseudonym: `Anon ${over.userId}`,
    interestIds: ["techno"],
    intents: ["dating"] as Intent[],
    workField: null,
    dating: { gender: null, interestedIn: [] },
    insideNow: true,
    checkedInAt: new Date("2026-08-10T21:00:00.000Z"),
    revealed: false,
    name: null,
    photo: null,
    ...over,
  })

  const viewerWho = (dating: { gender: Gender | null; interestedIn: Gender[] }, intents: Intent[] = ["dating", "networking"]) => ({
    userId: "me",
    interestIds: ["techno"],
    intents,
    workField: null,
    dating,
  })

  const rank = (viewer: ReturnType<typeof viewerWho>, candidates: MatchCandidate[]) =>
    rankMatches(viewer, candidates, { interestHolders: new Map(), population: 20 })

  it("still lists two straight men, without claiming a dating match", () => {
    /*
     * The behaviour this PR is for, and the shape of the fix. A hard filter
     * here would be "the partition the one-pool decision exists to avoid" —
     * they still share techno, and they may still both be here to network.
     */
    const [m] = rank(viewerWho({ gender: "man", interestedIn: ["woman"] }), [
      candidate({ userId: "him", dating: { gender: "man", interestedIn: ["woman"] } }),
    ])
    expect(m.userId).toBe("him")
    expect(m.sharedIntents).not.toContain("dating")
  })

  it("keeps every other shared intent between them", () => {
    const [m] = rank(viewerWho({ gender: "man", interestedIn: ["woman"] }), [
      candidate({
        userId: "him",
        intents: ["dating", "networking"] as Intent[],
        dating: { gender: "man", interestedIn: ["woman"] },
      }),
    ])
    expect(m.sharedIntents).toEqual(["networking"])
  })

  it("claims the dating match when it is a real one", () => {
    const [m] = rank(viewerWho({ gender: "man", interestedIn: ["woman"] }), [
      candidate({ userId: "her", dating: { gender: "woman", interestedIn: ["man"] } }),
    ])
    expect(m.sharedIntents).toContain("dating")
  })

  it("drops the tag when either side has declared nothing", () => {
    const [m] = rank(viewerWho({ gender: "man", interestedIn: ["woman"] }), [
      candidate({ userId: "silent" }),
    ])
    expect(m.userId).toBe("silent")
    expect(m.sharedIntents).not.toContain("dating")
  })

  it("never puts gender or orientation on a card", () => {
    // The one that matters when the allow-list is refactored: these are
    // matching inputs, and `Match` has no field for either.
    const [m] = rank(viewerWho({ gender: "man", interestedIn: ["woman"] }), [
      candidate({ userId: "her", dating: { gender: "woman", interestedIn: ["man"] } }),
    ])
    expect(JSON.stringify(m)).not.toMatch(/gender|orientation|interestedIn|woman|man/)
  })
})
