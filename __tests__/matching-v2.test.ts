import { readFileSync } from "fs"
import { join } from "path"

import { westernSignFor } from "@/lib/about-you"
import {
  MAX_DISPLAY_LINES,
  orderLabels,
  rankMatches,
  tierBBudget,
  type MatchCandidate,
  type MatchViewer,
} from "@/lib/matching"
import {
  badgesFor,
  type BadgeFacts,
  crewHeld,
  crewHoldsAt,
  crewOverlaps,
  NO_TRAITS,
  personKeys,
  personOverlaps,
  roomTeam,
  signChip,
  sizeBalance,
  traitHolders,
  type DisplayTraits,
} from "@/lib/overlaps"
import { signPairRefusal, updateProfileSchema } from "@/lib/validations/profile"

/**
 * Matching v2 (plan v2 §8, step 10): the MV-U cases.
 *
 * "Rank on what people chose and did; display what they are." The ranking
 * half is `rankMatches`; everything a card prints beyond it is
 * `lib/overlaps.ts`, budgeted by `orderLabels`.
 */

const NONE = { gender: null, interestedIn: [] }
const viewer = (interestIds: string[]): MatchViewer => ({
  userId: "me",
  interestIds,
  intents: ["friendship"],
  workField: null,
  dating: NONE,
})
const candidate = (userId: string, interestIds: string[], minutesAgo: number, over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  userId,
  pseudonym: `P-${userId}`,
  interestIds,
  intents: ["friendship"],
  workField: null,
  dating: NONE,
  insideNow: true,
  checkedInAt: new Date(Date.UTC(2026, 9, 10, 20, 0) - minutesAgo * 60_000),
  revealed: false,
  name: null,
  photo: null,
  ...over,
})
const traits = (over: Partial<DisplayTraits> = {}): DisplayTraits => ({ ...NO_TRAITS, ...over })

/* -------------------------------------------------------------------------- */
/* MV-U01 · a rare overlap outranks a common one                              */
/* -------------------------------------------------------------------------- */

describe("Both CSK — in RCB country outranks Both RCB (MV-U01)", () => {
  // The room: eight others. Seven are RCB fans; one is CSK. The IPL leaves sit
  // under their parent, as the interest tree stores them.
  const parentOf = new Map([
    ["rcb", "ipl"],
    ["csk", "ipl"],
  ])
  const room = [
    candidate("csk-fan", ["csk", "ipl"], 30),
    // Arrived most recently, so on equal score the RCB fan would lead.
    candidate("rcb-fan", ["rcb", "ipl"], 1),
    ...[2, 3, 4, 5, 6, 7].map((n) => candidate(`rcb-${n}`, ["rcb", "ipl"], 60 + n)),
  ]
  const holders = new Map<string, number>()
  for (const c of room) for (const id of c.interestIds) holders.set(id, (holders.get(id) ?? 0) + 1)

  it("ranks the rare shared team first", () => {
    const ranked = rankMatches(viewer(["csk", "rcb", "ipl"]), room, {
      interestHolders: holders,
      parentOf,
      population: room.length,
    })
    expect(ranked[0].userId).toBe("csk-fan")
    expect(ranked.findIndex((m) => m.userId === "rcb-fan")).toBeGreaterThan(0)
  })

  it("says so, naming the room's team", () => {
    const iplTeams = new Map([
      ["csk", "CSK"],
      ["rcb", "RCB"],
    ])
    const lead = roomTeam(iplTeams, holders)
    expect(lead).toBe("RCB")
    const line = (them: string[]) =>
      personOverlaps(
        { traits: NO_TRAITS, interestIds: ["csk", "rcb", "ipl"] },
        { traits: NO_TRAITS, interestIds: them },
        { holders: new Map(), interestHolders: holders, population: room.length, iplTeams, roomTeam: lead },
        { max: 2, tierB: 0 }
      )
    expect(line(["csk", "ipl"])).toEqual([{ kind: "ipl", text: "Both CSK — in RCB country 💛" }])
    expect(line(["rcb", "ipl"])).toEqual([{ kind: "ipl", text: "Both RCB fans ❤️" }])
  })

  it("names no room team on a tie", () => {
    const iplTeams = new Map([
      ["csk", "CSK"],
      ["rcb", "RCB"],
    ])
    expect(roomTeam(iplTeams, new Map([["csk", 3], ["rcb", 3]]))).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* MV-U02 · the Tier B budget                                                 */
/* -------------------------------------------------------------------------- */

describe("the Tier B budget in orderLabels (MV-U02)", () => {
  const me = traits({
    answers: { coffee_or_chai: "a" },
    languages: ["malayalam", "kannada"],
    homeState: "kerala",
    sign: { slug: "leo", system: "western" },
  })
  const them = traits({
    answers: { coffee_or_chai: "a" },
    languages: ["malayalam", "kannada"],
    homeState: "kerala",
    sign: { slug: "leo", system: "western" },
  })
  const lines = (budget: { max: number; tierB: number }) =>
    personOverlaps(
      { traits: me, interestIds: [] },
      { traits: them, interestIds: [] },
      { holders: traitHolders([them]), interestHolders: new Map(), population: 9, iplTeams: new Map(), roomTeam: null },
      budget
    )
  const tierB = (ls: { kind: string }[]) => ls.filter((l) => ["language", "home_state", "sign"].includes(l.kind))

  it("a room of seven: no Tier B line, and no sign chip", () => {
    const budget = { max: MAX_DISPLAY_LINES, tierB: tierBBudget({ roomIsBigEnough: false, revealed: false }) }
    const ls = lines(budget)
    expect(tierB(ls)).toEqual([])
    // Tier A still prints.
    expect(ls).toEqual([{ kind: "this_or_that", text: "You both picked filter coffee over chai" }])
    expect(signChip(them, ls, budget)).toBeNull()
  })

  it("a room of eight or more: exactly one Tier B line", () => {
    const ls = lines({ max: MAX_DISPLAY_LINES, tierB: tierBBudget({ roomIsBigEnough: true, revealed: false }) })
    expect(tierB(ls)).toHaveLength(1)
    expect(ls).toHaveLength(2)
  })

  it("after a reveal: unbudgeted", () => {
    const ls = lines({ max: 4, tierB: tierBBudget({ roomIsBigEnough: false, revealed: true }) })
    expect(tierB(ls).length).toBeGreaterThan(1)
  })

  it("rankMatches decides the budget, by the same floor as the work field", () => {
    const people = (n: number) => Array.from({ length: n }, (_, i) => candidate(`p${i}`, [], i))
    const budgetAt = (n: number, revealed = false) =>
      rankMatches(viewer([]), people(n).map((c) => ({ ...c, revealed })), { interestHolders: new Map(), population: n })[0]
        .labelBudget
    expect(budgetAt(7)).toEqual({ max: 2, tierB: 0 })
    expect(budgetAt(8)).toEqual({ max: 2, tierB: 1 })
    expect(budgetAt(3, true)).toEqual({ max: 4, tierB: Number.POSITIVE_INFINITY })
  })

  it("orderLabels skips Tier B past the budget and keeps filling with Tier A", () => {
    const got = orderLabels(
      [
        { id: "b1", tier: "B" as const, weight: 9 },
        { id: "b2", tier: "B" as const, weight: 8 },
        { id: "a1", tier: "A" as const, weight: 1 },
      ],
      { max: 2, tierB: 1 }
    )
    expect(got.map((l) => l.id)).toEqual(["b1", "a1"])
  })

  it("the sign chip shows only when Tier B is left, and not beside a sign line", () => {
    const leo = traits({ sign: { slug: "leo", system: "rashi" } })
    expect(signChip(leo, [], { tierB: 1 })).toBe("Simha ♌")
    expect(signChip(leo, [{ kind: "home_state", text: "Both from Kerala" }], { tierB: 1 })).toBeNull()
    expect(signChip(leo, [{ kind: "sign", text: "x" }], { tierB: 4 })).toBeNull()
    expect(signChip(traits(), [], { tierB: 1 })).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* MV-U03 · the lines themselves: positive only                               */
/* -------------------------------------------------------------------------- */

describe("what a card says (MV-U03)", () => {
  const say = (a: Partial<DisplayTraits>, b: Partial<DisplayTraits>) =>
    personOverlaps(
      { traits: traits(a), interestIds: [] },
      { traits: traits(b), interestIds: [] },
      { holders: new Map(), interestHolders: new Map(), population: 10, iplTeams: new Map(), roomTeam: null },
      { max: 4, tierB: 4 }
    ).map((l) => l.text)

  it("signs: same sign, two calendars, an element — never a mismatch", () => {
    expect(say({ sign: { slug: "leo", system: "western" } }, { sign: { slug: "leo", system: "western" } })).toEqual([
      "Both Leos ♌ — the stars approve",
    ])
    expect(say({ sign: { slug: "leo", system: "western" } }, { sign: { slug: "leo", system: "rashi" } })).toEqual([
      "Leo and Simha — same sign, two calendars ♌",
    ])
    expect(say({ sign: { slug: "aries", system: "western" } }, { sign: { slug: "sagittarius", system: "western" } })).toEqual([
      "Two fire signs 🔥",
    ])
    // Fire and water: nothing at all, never "incompatible".
    expect(say({ sign: { slug: "leo", system: "western" } }, { sign: { slug: "cancer", system: "western" } })).toEqual([])
  })

  it("languages, home state and this-or-that", () => {
    expect(say({ languages: ["kannada_learning"] }, { languages: ["kannada_learning", "tamil"] })).toEqual([
      "You're both learning Kannada",
    ])
    expect(say({ homeState: "abroad" }, { homeState: "abroad" })).toEqual(["You both grew up abroad"])
    expect(say({ answers: { metro_or_auto: "b" } }, { answers: { metro_or_auto: "b" } })).toEqual([
      "You both picked an auto over the metro",
    ])
    expect(say({ answers: { metro_or_auto: "a" } }, { answers: { metro_or_auto: "b" } })).toEqual([])
    expect(say({ languages: ["tamil"], homeState: "kerala" }, { languages: ["telugu"], homeState: "goa" })).toEqual([])
  })

  it("the Western sign of a birth date, at the edges", () => {
    const sign = (iso: string) => westernSignFor(new Date(`${iso}T00:00:00Z`))
    expect(sign("2000-01-19")).toBe("capricorn")
    expect(sign("2000-01-20")).toBe("aquarius")
    expect(sign("1999-07-23")).toBe("leo")
    expect(sign("1999-07-22")).toBe("cancer")
    expect(sign("1998-12-22")).toBe("capricorn")
    expect(sign("1998-12-21")).toBe("sagittarius")
    expect(westernSignFor(null)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* MV-U04 · badges you cannot buy                                             */
/* -------------------------------------------------------------------------- */

describe("badges from check-ins (MV-U04)", () => {
  const facts: BadgeFacts = { nightsHere: 0, nightsOut: 0, rsvpsPast: 0, rsvpsAttended: 0, showsUpOptIn: false }
  const kinds = (f: Partial<BadgeFacts>) => badgesFor({ ...facts, ...f }).map((b) => b.kind)

  it("Regular here at three nights, only where there is a venue", () => {
    expect(kinds({ nightsHere: 2 })).toEqual([])
    expect(kinds({ nightsHere: 3 })).toEqual(["regular_here"])
    expect(kinds({ nightsHere: null })).toEqual([])
  })
  it("Shows up: opted in, at least three RSVPs, 80% kept", () => {
    expect(kinds({ showsUpOptIn: true, rsvpsPast: 5, rsvpsAttended: 4 })).toEqual(["shows_up"])
    expect(kinds({ showsUpOptIn: true, rsvpsPast: 5, rsvpsAttended: 3 })).toEqual([])
    expect(kinds({ showsUpOptIn: true, rsvpsPast: 2, rsvpsAttended: 2 })).toEqual([])
    expect(kinds({ showsUpOptIn: false, rsvpsPast: 5, rsvpsAttended: 5 })).toEqual([])
  })
  it("five nights is a tier, never a count", () => {
    expect(kinds({ nightsOut: 4 })).toEqual([])
    expect(badgesFor({ ...facts, nightsOut: 11 })).toEqual([{ kind: "nights_out", label: "5+ nights this month" }])
  })
})

/* -------------------------------------------------------------------------- */
/* MV-U05 · what a crew holds                                                  */
/* -------------------------------------------------------------------------- */

describe("crew-held signals and size balance (MV-U05)", () => {
  const m = (interestIds: string[], t: Partial<DisplayTraits> = {}) => ({ interestIds, traits: traits(t) })

  it("two members and a third of the crew, never one person's taste", () => {
    expect(crewHoldsAt(2)).toBe(2)
    expect(crewHoldsAt(12)).toBe(4)
    expect(crewHeld([m(["techno"]), m([]), m([])]).has("techno")).toBe(false)
    expect(crewHeld([m(["techno"]), m(["techno"]), m([])]).has("techno")).toBe(true)
    const twelve = Array.from({ length: 12 }, (_, i) => m(i < 3 ? ["techno"] : []))
    expect(crewHeld(twelve).has("techno")).toBe(false)
  })

  it("a this-or-that answer only as a majority", () => {
    const tie = crewHeld([
      m([], { answers: { coffee_or_chai: "a" } }),
      m([], { answers: { coffee_or_chai: "a" } }),
      m([], { answers: { coffee_or_chai: "b" } }),
      m([], { answers: { coffee_or_chai: "b" } }),
    ])
    expect([...tie].filter((k) => k.startsWith("tot:"))).toEqual([])
    const chai = crewHeld([m([], { answers: { coffee_or_chai: "b" } }), m([], { answers: { coffee_or_chai: "b" } }), m([])])
    expect(chai.has("tot:coffee_or_chai:b")).toBe(true)
  })

  const room = (tierBAllowed: boolean) => ({
    holders: new Map(),
    population: 3,
    parentOf: new Map(),
    categoryName: new Map([["techno", "Techno"]]),
    iplTeams: new Map([["rcb", "RCB"]]),
    tierBAllowed,
  })

  it("names what is shared, never a member or a count", () => {
    const mine = crewHeld([m(["techno", "rcb"], { homeState: "kerala" }), m(["techno", "rcb"], { homeState: "kerala" })])
    const theirs = crewHeld([m(["techno", "rcb"], { homeState: "kerala" }), m(["techno", "rcb"], { homeState: "kerala" })])
    const { overlaps } = crewOverlaps(mine, theirs, false, room(false))
    expect(overlaps.map((o) => o.text).sort()).toEqual(["Both crews are into Techno", "Two RCB crews ❤️"])
    for (const o of overlaps) expect(o.text).not.toMatch(/\d/)
  })

  it("origin-like lines only where allowed, and one at most", () => {
    const k = (t: Partial<DisplayTraits>) => crewHeld([m([], t), m([], t)])
    const both = { homeState: "kerala", languages: ["malayalam"] }
    expect(crewOverlaps(k(both), k(both), false, room(false)).overlaps).toEqual([])
    const allowed = crewOverlaps(k(both), k(both), false, room(true)).overlaps
    expect(allowed).toHaveLength(1)
    expect(["Both crews have folks from Kerala", "Both crews have Malayalam speakers"]).toContain(allowed[0].text)
  })

  it("speaks to a person on their own", () => {
    const me = personKeys(m(["techno"], { answers: { coffee_or_chai: "b" } }))
    const theirs = crewHeld([m(["techno"], { answers: { coffee_or_chai: "b" } }), m(["techno"], { answers: { coffee_or_chai: "b" } })])
    expect(crewOverlaps(me, theirs, true, room(false)).overlaps.map((o) => o.text).sort()).toEqual([
      "This crew is into Techno, like you",
      "This crew picks chai over filter coffee, like you",
    ])
  })

  it("damps a crew more than twice the other's size, and only crew to crew", () => {
    expect(sizeBalance(2, 4)).toBe(1)
    expect(sizeBalance(2, 5)).toBe(0.5)
    expect(sizeBalance(6, 2)).toBe(0.5)
    expect(sizeBalance(null, 6)).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* MV-G02 · display traits never reach the score                              */
/* -------------------------------------------------------------------------- */

describe("the ranking never reads a display trait (MV-G02)", () => {
  /*
   * The score lives in lib/matching.ts. Language, home state, sign and
   * this-or-that live in lib/overlaps.ts and reach the card only. If the
   * ranking module ever names one of them, a display trait has found its way
   * toward a score — zodiac as a ranking signal is out of scope by ruling.
   */
  const src = readFileSync(join(__dirname, "..", "lib", "matching.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
  it.each(["languages", "home_state", "homeState", "sun_sign", "sign_system", "traits", "answers", "this_or_that", "overlaps"])(
    "lib/matching.ts does not read %s",
    (name) => {
      expect(src).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
  )
})

/* -------------------------------------------------------------------------- */
/* MV-U06 · the profile fields are validated                                  */
/* -------------------------------------------------------------------------- */

describe("the profile accepts only the curated values (MV-U06)", () => {
  const ok = (body: object) => updateProfileSchema.safeParse(body).success
  it("languages: known, at most five, each once", () => {
    expect(ok({ languages: ["kannada", "tamil"] })).toBe(true)
    expect(ok({ languages: ["klingon"] })).toBe(false)
    expect(ok({ languages: ["kannada", "kannada"] })).toBe(false)
    expect(ok({ languages: ["kannada", "tamil", "telugu", "malayalam", "hindi", "urdu"] })).toBe(false)
  })
  it("a state or territory, or abroad", () => {
    expect(ok({ home_state: "kerala" })).toBe(true)
    expect(ok({ home_state: "abroad" })).toBe(true)
    expect(ok({ home_state: "koramangala" })).toBe(false)
    expect(ok({ home_state: null })).toBe(true)
  })
  it("a sign comes with its calendar, both or neither", () => {
    expect(ok({ sun_sign: "leo", sign_system: "rashi" })).toBe(true)
    expect(ok({ sun_sign: "ophiuchus", sign_system: "western" })).toBe(false)
    expect(ok({ sun_sign: "leo", sign_system: "vedic-moon" })).toBe(false)
    expect(signPairRefusal({ sun_sign: "leo" })).not.toBeNull()
    expect(signPairRefusal({ sun_sign: "leo", sign_system: null })).not.toBeNull()
    expect(signPairRefusal({ sun_sign: null, sign_system: null })).toBeNull()
    expect(signPairRefusal({ sun_sign: "leo", sign_system: "western" })).toBeNull()
    expect(signPairRefusal({})).toBeNull()
  })
})
