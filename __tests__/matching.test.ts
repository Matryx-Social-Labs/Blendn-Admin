import {
  effectiveIntents,
  interestWeight,
  rankMatches,
  type Intent,
  type MatchCandidate,
} from "@/lib/matching"

/**
 * Ranking people, pinned.
 *
 * The failure that matters is not a mediocre ordering — it is a ranking that
 * quietly discloses someone who chose to stay anonymous, or that hard-filters
 * the pool of a new app down to an empty screen.
 */

const T0 = new Date("2026-08-07T21:00:00.000Z")

function candidate(over: Partial<MatchCandidate> & { userId: string }): MatchCandidate {
  return {
    pseudonym: `Anon ${over.userId}`,
    interestIds: [],
    intents: [],
    workField: null,
    dating: { gender: null, interestedIn: [] },
    insideNow: true,
    checkedInAt: T0,
    revealed: false,
    name: null,
    photo: null,
    ...over,
  }
}

/** A room where "music" is universal and "modular" is rare. */
const HOLDERS = new Map([
  ["music", 100],
  ["techno", 12],
  ["modular", 2],
  ["boardgames", 8],
])
const POPULATION = 100

const viewer = {
  userId: "me",
  interestIds: ["music", "techno", "modular", "boardgames"],
  intents: ["networking"] as Intent[],
  workField: null,
  dating: { gender: null, interestedIn: [] },
}

const rank = (candidates: MatchCandidate[]) =>
  rankMatches(viewer, candidates, { interestHolders: HOLDERS, population: POPULATION })

describe("rarity beats raw overlap", () => {
  it("weights a niche category above a universal one", () => {
    expect(interestWeight("modular", HOLDERS, POPULATION)).toBeGreaterThan(
      interestWeight("techno", HOLDERS, POPULATION)
    )
    expect(interestWeight("techno", HOLDERS, POPULATION)).toBeGreaterThan(
      interestWeight("music", HOLDERS, POPULATION)
    )
  })

  it("ranks one rare match above two common ones", () => {
    // The whole point. Counting boxes rewards indiscriminate tagging and buries
    // the two people who actually found each other.
    const ranked = rank([
      candidate({ userId: "common", interestIds: ["music", "boardgames"] }),
      candidate({ userId: "rare", interestIds: ["modular"] }),
    ])
    expect(ranked[0].userId).toBe("rare")
  })

  it("never scores a category negative, however universal", () => {
    // A category everyone holds is worth nothing, not worth less than nothing.
    expect(interestWeight("music", new Map([["music", 500]]), 100)).toBe(0)
  })

  it("survives a category nobody else holds", () => {
    expect(Number.isFinite(interestWeight("unheard-of", new Map(), 100))).toBe(true)
  })
})

describe("intent shapes the order and never filters", () => {
  it("prefers someone here for the same reason", () => {
    const ranked = rank([
      candidate({ userId: "other", interestIds: ["techno"], intents: ["dating"] }),
      candidate({ userId: "same", interestIds: ["techno"], intents: ["networking"] }),
    ])
    expect(ranked[0].userId).toBe("same")
  })

  it("still shows someone who came only for the event", () => {
    // A hard filter is the partition the one-pool decision exists to avoid — and
    // people change their minds during an evening.
    const ranked = rank([candidate({ userId: "justhere", intents: ["just_here"] })])
    expect(ranked.map((m) => m.userId)).toContain("justhere")
  })

  it("ranks them below someone open to meeting people", () => {
    const ranked = rank([
      candidate({ userId: "justhere", interestIds: ["techno"], intents: ["just_here"] }),
      candidate({ userId: "open", interestIds: ["techno"], intents: ["networking"] }),
    ])
    expect(ranked[0].userId).toBe("open")
  })

  it("does not damp someone who picked just_here alongside something social", () => {
    // "I'm here for the talk and open to meeting people" is not "leave me alone".
    const ranked = rank([
      candidate({ userId: "both", interestIds: ["techno"], intents: ["just_here", "networking"] }),
      candidate({ userId: "only", interestIds: ["techno"], intents: ["just_here"] }),
    ])
    expect(ranked[0].userId).toBe("both")
  })

  it("damps silence exactly as hard as an explicit just_here", () => {
    /*
     * The honest answer must not cost anything.
     *
     * The damping guard used to read `intents.length > 0 && every(...)`, so an
     * empty intent array escaped it while an explicit `just_here` did not —
     * with otherwise identical interests the two scored differently, and the
     * person who answered the question truthfully ranked strictly below the
     * person who declined to answer it. Neither says "come and talk to me", and
     * a product built on knowing what someone is open to must not reward
     * saying nothing.
     */
    const ranked = rank([
      candidate({ userId: "silent", interestIds: ["techno"], intents: [] }),
      candidate({ userId: "honest", interestIds: ["techno"], intents: ["just_here"] }),
    ])

    /*
     * Both are damped, so they tie on score and fall through to the check-in
     * time (identical here) and then to `userId.localeCompare`, which puts
     * "honest" first. With the old guard "silent" was undamped, scored higher,
     * and led — so this assertion is what actually distinguishes the fix from
     * the bug rather than merely passing either way.
     */
    expect(ranked[0].userId).toBe("honest")
  })
})

describe("presence", () => {
  it("puts someone still in the room above someone who left", () => {
    const ranked = rank([
      candidate({ userId: "gone", interestIds: ["techno"], insideNow: false }),
      candidate({ userId: "here", interestIds: ["techno"], insideNow: true }),
    ])
    expect(ranked[0].userId).toBe("here")
  })

  it("does not hide people who left — they were still in the room with you", () => {
    const ranked = rank([candidate({ userId: "gone", insideNow: false })])
    expect(ranked).toHaveLength(1)
  })
})

describe("anonymity is enforced in the ranking, not by the caller", () => {
  it("shows the pseudonym and no photo by default", () => {
    const [m] = rank([
      candidate({ userId: "shy", name: "Priya Raman", photo: "https://x/p.jpg", revealed: false }),
    ])
    expect(m.displayName).toBe("Anon shy")
    expect(m.photo).toBeNull()
    expect(JSON.stringify(m)).not.toContain("Priya")
  })

  it("shows the real name only when they chose to reveal", () => {
    const [m] = rank([
      candidate({ userId: "open", name: "Priya Raman", photo: "https://x/p.jpg", revealed: true }),
    ])
    expect(m.displayName).toBe("Priya Raman")
    expect(m.photo).toBe("https://x/p.jpg")
  })

  it("falls back to the pseudonym if a revealed profile has no name", () => {
    // Degrading to "Anonymous" or an empty string would be a worse card; falling
    // back to the name they already carry in the room is the honest default.
    const [m] = rank([candidate({ userId: "nameless", revealed: true, name: null })])
    expect(m.displayName).toBe("Anon nameless")
  })

  it("never emits a score", () => {
    // A number implies a precision this data cannot support, and invites gaming.
    const [m] = rank([candidate({ userId: "x", interestIds: ["techno"] })])
    expect(Object.keys(m)).not.toContain("score")
    expect(JSON.stringify(m)).not.toMatch(/score|rank|percent/i)
  })
})

describe("the card carries the overlaps", () => {
  it("names exactly what the two people share", () => {
    const [m] = rank([
      candidate({ userId: "x", interestIds: ["techno", "boardgames", "hiking"], intents: ["networking"] }),
    ])
    expect(m.sharedInterestIds.sort()).toEqual(["boardgames", "techno"])
    expect(m.sharedIntents).toEqual(["networking"])
  })

  it("does not claim an overlap on just_here", () => {
    // "We are both merely present" is not something to say to anyone.
    const withJustHere = rankMatches(
      { ...viewer, intents: ["just_here", "networking"] },
      [candidate({ userId: "x", intents: ["just_here"] })],
      { interestHolders: HOLDERS, population: POPULATION }
    )
    expect(withJustHere[0].sharedIntents).toEqual([])
  })
})

/**
 * The room production actually has today.
 *
 * `user_interests` is empty in production -- onboarding writes free text to
 * `profiles.interests` instead -- so every candidate arrives with
 * `interestIds: []`. Nothing errors. Every existing test in this file seeds
 * interests, so the whole suite is green while the feature returns nothing
 * useful to anybody.
 *
 * These pin what "broken" is allowed to look like: honest, ordered, and
 * complete. If the ranking ever starts inventing a number or silently dropping
 * people to hide the emptiness, this block fails.
 */
describe("a room where nobody has structured interests", () => {
  const emptyRoom = [
    candidate({ userId: "a", intents: ["networking"], checkedInAt: new Date(T0.getTime() - 60_000) }),
    candidate({ userId: "b", checkedInAt: T0 }),
    candidate({ userId: "c", intents: ["dating"], insideNow: false, checkedInAt: T0 }),
  ]

  it("still returns everyone rather than an empty screen", () => {
    // Hard-filtering on overlap would empty a new app's only screen.
    expect(rank(emptyRoom).map((m) => m.userId).sort()).toEqual(["a", "b", "c"])
  })

  it("names no overlap it cannot substantiate", () => {
    for (const match of rank(emptyRoom)) {
      expect(match.sharedInterestIds).toEqual([])
    }
  })

  it("emits no score to paper over the emptiness", () => {
    // A percentage here would be pure fabrication -- there is nothing to
    // compute it from.
    for (const match of rank(emptyRoom)) {
      expect(match).not.toHaveProperty("score")
    }
  })

  it("still orders on something real: shared intent, then presence", () => {
    // With interests gone, intent and presence are the only honest signals
    // left. "a" shares networking with the viewer; "c" is both a different
    // intent and already gone.
    const order = rank(emptyRoom).map((m) => m.userId)
    expect(order[0]).toBe("a")
    expect(order[order.length - 1]).toBe("c")
  })

  it("is deterministic, so paging cannot repeat or drop someone", () => {
    expect(rank(emptyRoom).map((m) => m.userId)).toEqual(rank(emptyRoom).map((m) => m.userId))
  })

  it("keeps the pseudonym rule when there is nothing else to show", () => {
    // The temptation with a blank card is to fill it with a real name.
    for (const match of rank(emptyRoom)) {
      expect(match.displayName).toMatch(/^Anon /)
      expect(match.photo).toBeNull()
    }
  })
})

describe("housekeeping", () => {
  it("never returns the viewer", () => {
    expect(rank([candidate({ userId: "me" }), candidate({ userId: "other" })])).toHaveLength(1)
  })

  it("orders identically on repeated calls", () => {
    // Paging over an unstable sort silently drops and repeats people.
    const pool = ["a", "b", "c", "d"].map((userId) => candidate({ userId }))
    expect(rank(pool).map((m) => m.userId)).toEqual(rank([...pool].reverse()).map((m) => m.userId))
  })

  it("respects the limit", () => {
    const pool = ["a", "b", "c"].map((userId) => candidate({ userId }))
    expect(
      rankMatches(viewer, pool, { interestHolders: HOLDERS, population: POPULATION, limit: 2 })
    ).toHaveLength(2)
  })

  it("returns an empty room rather than throwing", () => {
    expect(rankMatches(viewer, [], { interestHolders: new Map(), population: 0 })).toEqual([])
  })
})

describe("intent falls back to the profile default", () => {
  it("uses the per-event choice when there is one", () => {
    expect(effectiveIntents(["dating"], ["networking"])).toEqual(["dating"])
  })

  it("falls back when they did not choose for this event", () => {
    expect(effectiveIntents([], ["networking"])).toEqual(["networking"])
  })
})
