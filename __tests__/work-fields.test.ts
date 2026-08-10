import { MIN_ATTENDEES } from "@/lib/connection-metrics"
import {
  MIN_ROOM_FOR_WORK_FIELD,
  WORK_FIELDS,
  isWorkField,
  workFieldLabel,
} from "@/lib/work-fields"
import { updateProfileSchema } from "@/lib/validations/profile"
import { rankMatches, WORK_FIELD_BONUS, INTENT_BONUS, type MatchCandidate } from "@/lib/matching"

/**
 * Field of work: a server-owned list, and a floor below which it is not said.
 *
 * The list matters because the last time this codebase collected an attribute
 * as free text — `profiles.interests` — two people who typed "Software" and
 * "software engineering" could never match, and unpicking it took two PRs. The
 * floor matters because the roster already gives an unrevealed person an age
 * and a city, and four attributes name one person in a small room.
 */

describe("the list", () => {
  it("has no duplicate slugs", () => {
    // A duplicate would make one bucket unreachable through the map.
    const slugs = WORK_FIELDS.map((f) => f.slug)
    expect(slugs).toEqual([...new Set(slugs)])
  })

  it("has no duplicate labels", () => {
    const labels = WORK_FIELDS.map((f) => f.label)
    expect(labels).toEqual([...new Set(labels)])
  })

  it("uses snake_case slugs so a label can be renamed without orphaning rows", () => {
    for (const { slug } of WORK_FIELDS) {
      expect(slug).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it("offers an escape hatch", () => {
    // Without one, somebody whose work is not listed picks a bucket that is
    // wrong — which is worse for matching and worse on the card than "other".
    expect(WORK_FIELDS.some((f) => f.slug === "other")).toBe(true)
  })

  it("stays short enough to scroll in one screen", () => {
    // Finer categories are more informative and more identifying; that is the
    // wrong trade in a room built on nobody being findable.
    expect(WORK_FIELDS.length).toBeLessThanOrEqual(20)
    expect(WORK_FIELDS.length).toBeGreaterThanOrEqual(12)
  })

  it("recognises its own slugs and nothing else", () => {
    expect(isWorkField("design")).toBe(true)
    expect(isWorkField("Design")).toBe(false)
    expect(isWorkField("astronaut")).toBe(false)
    expect(isWorkField(null)).toBe(false)
    expect(isWorkField(42)).toBe(false)
  })

  it("never renders a raw slug", () => {
    expect(workFieldLabel("data_ai")).toBe("Data & AI")
    // An unknown slug returns null rather than itself: a card showing
    // "data_ai" is worse than a card showing nothing.
    expect(workFieldLabel("removed_bucket")).toBeNull()
    expect(workFieldLabel(null)).toBeNull()
  })
})

describe("the validator", () => {
  it("accepts a slug from the list", () => {
    expect(updateProfileSchema.safeParse({ work_field: "software" }).success).toBe(true)
  })

  it("refuses free text", () => {
    // The whole point. "software engineering" and "Software" would be two
    // buckets that never match, which is the interests taxonomy all over again.
    expect(updateProfileSchema.safeParse({ work_field: "software engineering" }).success).toBe(false)
  })

  it("allows clearing it", () => {
    expect(updateProfileSchema.safeParse({ work_field: null }).success).toBe(true)
  })
})

describe("the small-room floor", () => {
  it("is the same number as the organiser metrics floor", () => {
    // Declared separately because `connection-metrics` imports `db` and this
    // module is reachable from a validator a client component may import.
    // Equal here so the two cannot drift in silence.
    expect(MIN_ROOM_FOR_WORK_FIELD).toBe(MIN_ATTENDEES)
  })

  const candidate = (over: Partial<MatchCandidate> & { userId: string }): MatchCandidate => ({
    pseudonym: `Anon ${over.userId}`,
    interestIds: [],
    intents: [],
    workField: null,
    insideNow: true,
    checkedInAt: new Date("2026-08-10T21:00:00.000Z"),
    revealed: false,
    name: null,
    photo: null,
    ...over,
  })

  const viewer = { userId: "me", interestIds: [], intents: [], workField: "design" }
  const rank = (population: number) =>
    rankMatches(viewer, [candidate({ userId: "x", workField: "design" })], {
      interestHolders: new Map(),
      population,
    })

  it("says the field of work in a room big enough to hide in", () => {
    expect(rank(MIN_ROOM_FOR_WORK_FIELD)[0].workField).toBe("design")
  })

  it("withholds it one person below the floor", () => {
    // "29, Bengaluru, works in design, into techno" is one specific person in a
    // room of seven, and the pseudonym stops doing anything at all.
    expect(rank(MIN_ROOM_FOR_WORK_FIELD - 1)[0].workField).toBeNull()
  })

  it("still ranks on it in a small room, because the score is never shown", () => {
    // Suppressing the attribute is about disclosure. The ordering discloses
    // nothing — no number leaves `matching.ts` — so there is no reason to make
    // small rooms rank worse as well.
    const withMatch = rankMatches(
      viewer,
      [candidate({ userId: "same", workField: "design" }), candidate({ userId: "diff", workField: "finance" })],
      { interestHolders: new Map(), population: 2 }
    )
    expect(withMatch[0].userId).toBe("same")
    expect(withMatch[0].workField).toBeNull()
  })
})

describe("the bonus", () => {
  const candidate = (over: Partial<MatchCandidate> & { userId: string }): MatchCandidate => ({
    pseudonym: `Anon ${over.userId}`,
    interestIds: [],
    intents: [],
    workField: null,
    insideNow: true,
    checkedInAt: new Date("2026-08-10T21:00:00.000Z"),
    revealed: false,
    name: null,
    photo: null,
    ...over,
  })

  it("is worth less than a shared intent", () => {
    // At a fintech meetup everyone shares "Finance & Banking", so it says even
    // less than two people both ticking "networking" at a networking event.
    expect(WORK_FIELD_BONUS).toBeLessThan(INTENT_BONUS)
  })

  it("prefers someone in the same field, all else equal", () => {
    const ranked = rankMatches(
      { userId: "me", interestIds: [], intents: [], workField: "design" },
      [candidate({ userId: "other", workField: "finance" }), candidate({ userId: "same", workField: "design" })],
      { interestHolders: new Map(), population: 20 }
    )
    expect(ranked[0].userId).toBe("same")
  })

  it("gives nothing when the viewer has not said what they do", () => {
    // Otherwise every null-vs-null pair would score as a match, and the whole
    // room would tie on a field nobody filled in.
    const ranked = rankMatches(
      { userId: "me", interestIds: [], intents: [], workField: null },
      [candidate({ userId: "a", workField: null }), candidate({ userId: "b", workField: "design" })],
      { interestHolders: new Map(), population: 20 }
    )
    // Tied on score, so the stable tiebreak decides — not the null pairing.
    expect(ranked.map((m) => m.userId)).toEqual(["a", "b"])
  })

  it("shows a field of work the viewer does not share", () => {
    // "Works in design" is a reason to walk over even if you do not. The bonus
    // needs both sides; the card only needs theirs.
    const [m] = rankMatches(
      { userId: "me", interestIds: [], intents: [], workField: "finance" },
      [candidate({ userId: "x", workField: "design" })],
      { interestHolders: new Map(), population: 20 }
    )
    expect(m.workField).toBe("design")
  })
})
