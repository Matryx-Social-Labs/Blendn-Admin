import {
  DATING_MIN_AGE,
  datingAgeRefusal,
  mayDate,
  minAgeRefusal,
  stripDating,
} from "@/lib/age"

/**
 * The age rules, and the one that JavaScript gets wrong for free.
 *
 * `profiles.age` is nullable and every OAuth account is created without one, so
 * the naive `age < 18` is `null < 18` — which is `true`, meaning the unknown
 * case sails through the check written to stop it. That single coercion is why
 * these are functions rather than inline comparisons at five call sites.
 */

describe("dating is 18+", () => {
  it("admits an adult", () => {
    expect(mayDate(DATING_MIN_AGE)).toBe(true)
    expect(mayDate(34)).toBe(true)
  })

  it("refuses someone below the line", () => {
    expect(mayDate(17)).toBe(false)
    expect(mayDate(13)).toBe(false)
  })

  it("refuses an unknown age rather than treating it as adult", () => {
    // The case the whole file exists for.
    expect(mayDate(null)).toBe(false)
    expect(mayDate(undefined)).toBe(false)
  })

  it("does not coerce null into a passing comparison", () => {
    // `null < 18` is false and `null >= 18` is false, so which comparison you
    // write decides whether an unknown age is admitted. Pinned explicitly
    // because it is the exact bug this replaces.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((null as any) < DATING_MIN_AGE).toBe(true)
    expect(mayDate(null)).toBe(false)
  })
})

describe("datingAgeRefusal", () => {
  it("says nothing when dating was not asked for", () => {
    expect(datingAgeRefusal(["networking", "friendship"], 15)).toBeNull()
    expect(datingAgeRefusal([], 15)).toBeNull()
    expect(datingAgeRefusal(undefined, 15)).toBeNull()
  })

  it("allows an adult to pick dating", () => {
    expect(datingAgeRefusal(["dating", "networking"], 30)).toBeNull()
  })

  it("refuses a 17-year-old and names the rule", () => {
    const refusal = datingAgeRefusal(["dating"], 17)
    expect(refusal).toMatch(/18\+/)
  })

  it("asks for an age rather than stating a rule the user cannot check", () => {
    // Two different refusals because they need two different actions: one
    // person adds their age, the other cannot proceed at all.
    expect(datingAgeRefusal(["dating"], null)).toMatch(/add your age/i)
    expect(datingAgeRefusal(["dating"], 17)).not.toMatch(/add your age/i)
  })

  it("catches dating anywhere in the list, not just first", () => {
    expect(datingAgeRefusal(["networking", "just_here", "dating"], 16)).not.toBeNull()
  })
})

describe("stripDating", () => {
  it("leaves an adult's intents alone", () => {
    expect(stripDating(["dating", "networking"], 25)).toEqual(["dating", "networking"])
  })

  it("removes only the gated tag, keeping the rest", () => {
    // Someone under 18 is still here to make friends. Dropping the whole array
    // would erase a choice they are entitled to make.
    expect(stripDating(["dating", "friendship"], 16)).toEqual(["friendship"])
  })

  it("strips on an unknown age", () => {
    expect(stripDating(["dating"], null)).toEqual([])
  })

  it("returns a copy rather than mutating the input", () => {
    // It is called on a row read straight out of Prisma; mutating that would
    // change what gets written back a few lines later.
    const original: string[] = ["dating", "networking"]
    stripDating(original, 15)
    expect(original).toEqual(["dating", "networking"])
  })
})

describe("an event with a minimum age", () => {
  it("says nothing for the events that have no restriction", () => {
    // Which is nearly all of them, so this is the hot path.
    expect(minAgeRefusal(15, null)).toBeNull()
    expect(minAgeRefusal(null, null)).toBeNull()
    expect(minAgeRefusal(null, undefined)).toBeNull()
  })

  it("admits someone exactly at the line", () => {
    expect(minAgeRefusal(18, 18)).toBeNull()
  })

  it("refuses someone below it, quoting the event's own number", () => {
    expect(minAgeRefusal(17, 21)).toBe("This event is 21+.")
  })

  it("refuses an unknown age and says what to do about it", () => {
    // Refused at the door even though the listing tolerates an unknown age:
    // hiding every restricted event from every OAuth account would empty their
    // feed, whereas this costs one tap and names the fix.
    expect(minAgeRefusal(null, 18)).toMatch(/add your age/i)
  })
})
