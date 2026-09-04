import {
  collapseToMostSpecific,
  effectiveIntents,
  interestWeight,
  rankMatches,
  CO_ATTENDANCE_CAP,
  type Intent,
  type MatchCandidate,
  type MatchViewer,
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

describe("sharedWorkField cannot become a second door onto workField", () => {
  const designer = { ...viewer, workField: "design" }
  const rankAs = (v: MatchViewer, candidates: MatchCandidate[], population: number) =>
    rankMatches(v, candidates, { interestHolders: HOLDERS, population })

  /* One other person in the room: far below MIN_ROOM_FOR_WORK_FIELD (8). */
  const tiny = [candidate({ userId: "them", workField: "design" })]

  it("says so in a room big enough to say it", () => {
    const [m] = rankAs(designer, tiny, 100)
    expect(m.workField).toBe("design")
    expect(m.sharedWorkField).toBe(true)
  })

  it("is false below the floor, where workField is already withheld", () => {
    /*
     * The whole point. `workField` is suppressed here — but the viewer knows
     * their OWN field, so a `true` would name the candidate's exactly. It would
     * hand back the suppressed attribute through a different field name.
     */
    const [m] = rankAs(designer, tiny, 2)
    expect(m.workField).toBeNull()
    expect(m.sharedWorkField).toBe(false)
  })

  it("is false below the floor even when the fields differ", () => {
    /*
     * Not merely "do not confirm a match" — do not answer at all. A `false` that
     * meant "definitely a different field" would eliminate one of nineteen per
     * card, which in a room of eight is a real cut. Below the floor every card
     * reads the same, which is what makes it uninformative.
     */
    const [m] = rankAs(designer, [candidate({ userId: "them", workField: "finance" })], 2)
    expect(m.sharedWorkField).toBe(false)
  })

  it("is false when the viewer has not said what they do", () => {
    // Nothing to share with. The old expression was truthy-on-null-equals-null,
    // which would have claimed a match between two people who both said nothing.
    const [m] = rankAs(viewer, [candidate({ userId: "them", workField: null })], 100)
    expect(m.sharedWorkField).toBe(false)
  })

  it("is false when they have not said, and the viewer has", () => {
    const [m] = rankAs(designer, [candidate({ userId: "them", workField: null })], 100)
    expect(m.sharedWorkField).toBe(false)
  })

  it("uses the same floor as workField, not one of its own", () => {
    /*
     * Walks the boundary. Two constants that must move together are two
     * constants that will eventually not, so this asserts the transition
     * happens at the same population for both fields.
     */
    for (const population of [6, 7, 8, 9]) {
      const [m] = rankAs(designer, tiny, population)
      expect(m.sharedWorkField).toBe(m.workField !== null)
    }
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

/*
 * ─────────────────────────────────────────────────────────────────────────
 * Stage 2 — the taxonomy
 *
 *   music ──┬── techno
 *           └── modular
 *   sports ──┬── ipl
 *            └── running
 *
 * Storage is leaf-only. `lib/matches.ts` expands each person's holdings upward
 * before ranking, so two people into different leaves of the same parent meet
 * at the parent. `collapseToMostSpecific` then drops the parent when a leaf
 * under it is also shared, so one affinity scores once.
 * ─────────────────────────────────────────────────────────────────────────
 */
const PARENTS = new Map([
  ["techno", "music"],
  ["modular", "music"],
  ["ipl", "sports"],
  ["running", "sports"],
])

describe("collapseToMostSpecific", () => {
  it("keeps a shared leaf and drops the parent it implies", () => {
    // What an expanded intersection actually looks like: both hold techno, so
    // both hold music, so music is in the intersection carrying no information.
    expect(collapseToMostSpecific(["techno", "music"], PARENTS)).toEqual(["techno"])
  })

  it("keeps a shared parent when no leaf under it is shared", () => {
    // One is into IPL, the other into running. They meet at sports and nowhere
    // else — this is the overlap the whole stage exists to find.
    expect(collapseToMostSpecific(["sports"], PARENTS)).toEqual(["sports"])
  })

  it("keeps both siblings — two shared leaves are two affinities", () => {
    expect(collapseToMostSpecific(["techno", "modular", "music"], PARENTS)).toEqual([
      "techno",
      "modular",
    ])
  })

  it("does not drop a parent because some unrelated leaf is shared", () => {
    // `sports` is only redundant if one of ITS children is shared. `techno`
    // belongs to another branch and must not suppress it.
    expect(collapseToMostSpecific(["techno", "sports"], PARENTS)).toEqual(["techno", "sports"])
  })

  it("keeps an id the taxonomy does not know, rather than dropping it", () => {
    expect(collapseToMostSpecific(["chess"], PARENTS)).toEqual(["chess"])
  })

  it("returns an empty list for no overlap", () => {
    expect(collapseToMostSpecific([], PARENTS)).toEqual([])
  })

  /*
   * The hang guards. `categories.parent_id` is a plain self-relation, so a
   * third level and a cycle are both insertable, and a `while
   * (parentOf.has(id))` walk would spin the request thread forever on data
   * nobody can see is wrong.
   *
   * There is no walk. Each id checks its own immediate parent once, which
   * cannot loop by construction — and collapses a deep chain *correctly* as a
   * side effect: `sub` implies `techno`, `techno` implies `music`, both drop,
   * and only the most specific node survives.
   */
  it("collapses a three-level chain to the most specific, without walking", () => {
    const deep = new Map([
      ["sub", "techno"],
      ["techno", "music"],
    ])
    expect(collapseToMostSpecific(["sub", "techno", "music"], deep)).toEqual(["sub"])
  })

  it("terminates on a cycle", () => {
    const cyclic = new Map([
      ["a", "b"],
      ["b", "a"],
    ])
    expect(() => collapseToMostSpecific(["a", "b"], cyclic)).not.toThrow()
  })
})

describe("parent-aware ranking", () => {
  const rankWithTaxonomy = (candidates: MatchCandidate[], holders = HOLDERS, pop = POPULATION) =>
    rankMatches(viewer, candidates, {
      interestHolders: holders,
      parentOf: PARENTS,
      population: pop,
    })

  it("scores a shared leaf once, not twice with its parent", () => {
    const [match] = rankWithTaxonomy([
      candidate({ userId: "a", interestIds: ["techno", "music"] }),
    ])
    expect(match.sharedInterestIds).toEqual(["techno"])
  })

  it("ranks a shared leaf above a shared parent", () => {
    // "music" is held by everyone (weight 0); "techno" by 12 of 100.
    const [first, second] = rankWithTaxonomy([
      candidate({ userId: "parent-only", interestIds: ["music"] }),
      candidate({ userId: "leaf", interestIds: ["techno", "music"] }),
    ])
    expect(first.userId).toBe("leaf")
    expect(second.userId).toBe("parent-only")
  })

  it("works with no taxonomy supplied — flat behaviour, not a crash", () => {
    const [match] = rankMatches(viewer, [candidate({ userId: "a", interestIds: ["techno"] })], {
      interestHolders: HOLDERS,
      population: POPULATION,
    })
    expect(match.sharedInterestIds).toEqual(["techno"])
  })
})

describe("the card names the most distinguishing overlaps", () => {
  it("puts the rarest first", () => {
    const [match] = rankMatches(viewer, [
      candidate({ userId: "a", interestIds: ["music", "modular"] }),
    ], { interestHolders: HOLDERS, parentOf: PARENTS, population: POPULATION })
    expect(match.sharedInterestIds[0]).toBe("modular")
  })

  it("names at most two, so the card stays a reason rather than a profile", () => {
    const [match] = rankMatches(viewer, [
      candidate({ userId: "a", interestIds: ["music", "techno", "modular", "boardgames"] }),
    ], { interestHolders: HOLDERS, parentOf: PARENTS, population: POPULATION })
    expect(match.sharedInterestIds).toHaveLength(2)
  })

  /*
   * The regression that reversed a review decision.
   *
   * The obvious rule — drop overlaps scoring zero so the card and the score
   * agree — blanks the card entirely in a small room, because `population` is
   * the candidate count and `log(2/2)` is 0 for *every* interest however rare.
   * A brand-new event would show two people who share techno and tell them
   * they have nothing in common.
   */
  it("still names an overlap in a room too small for any weight to be positive", () => {
    const tiny = new Map([["techno", 1]])
    const [match] = rankMatches(viewer, [candidate({ userId: "a", interestIds: ["techno"] })], {
      interestHolders: tiny,
      parentOf: PARENTS,
      population: 1,
    })
    expect(interestWeight("techno", tiny, 1)).toBe(0)
    expect(match.sharedInterestIds).toEqual(["techno"])
  })
})

describe("shared history is the signal nobody can fake", () => {
  /*
   * Every other term in this ranking is something a person typed about
   * themselves. Co-attendance is the only one they had to physically do — and
   * the only one a product without verified check-in cannot compute at all.
   *
   * Worth more than a shared intent (0.6) and less than being in the room
   * (1.5): stronger than any declaration, weaker than "they are standing here".
   */
  it("ranks a pair with shared history above an identical pair without", () => {
    const [a, b] = rank([
      candidate({ userId: "history", sharedEvents: 2 }),
      candidate({ userId: "stranger", sharedEvents: 0 }),
    ])
    expect(a.userId).toBe("history")
    expect(b.userId).toBe("stranger")
  })

  it("stops counting past the cap", () => {
    /*
     * Three is a pattern; nine is a regular at one venue. Uncapped, this would
     * rank the room by who goes out most rather than by who is worth walking
     * over to — one strong signal becoming the only signal.
     */
    const ranked = rank([
      candidate({ userId: "regular", sharedEvents: 30 }),
      candidate({ userId: "capped", sharedEvents: CO_ATTENDANCE_CAP }),
    ])

    /*
     * Both score the SAME, so the tie falls through to the stable rules and
     * `capped` wins on `userId.localeCompare`. Without the cap, `regular` would
     * outscore it and come first.
     *
     * The first version of this assertion sorted the ids and compared the
     * sorted array, which passes in either order — a vacuous test that the
     * control caught by failing to break it. Asserting the position is the
     * whole point.
     */
    expect(ranked[0].userId).toBe("capped")
  })

  it("does not say it out loud in a small room", () => {
    /*
     * It looks harmless — the viewer already knows which events they attended.
     * It is not: in a small room it narrows a card to the few people who were
     * at those specific nights, and with the age and city the roster already
     * gives, that is a name.
     */
    const small = rankMatches(viewer, [candidate({ userId: "x", sharedEvents: 3 })], {
      interestHolders: HOLDERS,
      population: 4,
    })
    expect(small[0].sharedEvents).toBe(0)

    const big = rankMatches(viewer, [candidate({ userId: "x", sharedEvents: 3 })], {
      interestHolders: HOLDERS,
      population: 100,
    })
    expect(big[0].sharedEvents).toBe(3)
  })

  it("still RANKS on it in a small room, because the score is never shown", () => {
    // Suppressing the ranking as well would make small rooms rank worse for no
    // privacy gain — the card is what discloses, not the order.
    const ranked = rankMatches(
      viewer,
      [
        candidate({ userId: "stranger", sharedEvents: 0 }),
        candidate({ userId: "history", sharedEvents: 3 }),
      ],
      { interestHolders: HOLDERS, population: 4 }
    )
    expect(ranked[0].userId).toBe("history")
    expect(ranked[0].sharedEvents).toBe(0)
  })

  it("treats an absent count as no history rather than as an error", () => {
    // `sharedEvents` is optional on the way in, so a caller that does not
    // compute it degrades to today's ranking rather than to a wrong one.
    const ranked = rank([candidate({ userId: "unknown" })])
    expect(ranked[0].sharedEvents).toBe(0)
  })
})
