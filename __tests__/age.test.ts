import {
  DATING_MIN_AGE,
  ageFrom,
  datingAgeRefusal,
  mayDate,
  minAgeRefusal,
  parseDateOfBirth,
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

/* -------------------------------------------------------------------------- */
/* Where the age comes from                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The rules above are only as good as the number they are given, and that
 * number used to be captured at signup — wrong the next day, and wrong in the
 * direction that matters. Someone who signs up at 17 stays 17 in the table
 * forever, so `minAgeRefusal` keeps refusing them a year later.
 *
 * The birthday boundary is the whole test. Everything else is bookkeeping.
 */

// Fixed so the boundary cases are stable, and mid-year so tests can step either
// side of a birthday without crossing a year end.
const NOW = new Date("2026-06-15T12:00:00.000Z")

describe("ageFrom — the birthday boundary", () => {
  it("counts whole years, not calendar-year differences", () => {
    expect(ageFrom({ date_of_birth: "2008-06-15" }, NOW)).toBe(18)
  })

  it("is still 17 the day before the 18th birthday", () => {
    // The one that matters. Subtracting year numbers alone calls this 18 and
    // lets a 17-year-old past `minAgeRefusal`.
    expect(ageFrom({ date_of_birth: "2008-06-16" }, NOW)).toBe(17)
  })

  it("is 18 the day after", () => {
    expect(ageFrom({ date_of_birth: "2008-06-14" }, NOW)).toBe(18)
  })

  it("does not turn someone 18 on the 1st of January of their 18th year", () => {
    expect(ageFrom({ date_of_birth: "2008-12-31" }, NOW)).toBe(17)
  })

  it("handles a 29 February birthday in a non-leap year", () => {
    expect(ageFrom({ date_of_birth: "2008-02-29" }, NOW)).toBe(18)
  })
})

describe("ageFrom — falling back to the stored number", () => {
  it("uses the stored age when there is no date", () => {
    // Every row written before the column existed. A number cannot be turned
    // back into a date, so it stands until the person re-enters their birthday.
    expect(ageFrom({ age: 24 }, NOW)).toBe(24)
  })

  it("prefers the date over the stored number when both exist", () => {
    // The stored number is the stale one by construction.
    expect(ageFrom({ date_of_birth: "2000-01-01", age: 3 }, NOW)).toBe(26)
  })

  it("falls back when the date is corrupt", () => {
    expect(ageFrom({ date_of_birth: "not-a-date", age: 30 }, NOW)).toBe(30)
  })

  it("never returns a negative age for a future date", () => {
    // A negative age satisfies every `age >= minAge` comparison in this file.
    expect(ageFrom({ date_of_birth: "2099-01-01", age: 30 }, NOW)).toBe(30)
  })
})

describe("ageFrom — when we genuinely do not know", () => {
  it("is null, which the rules above already refuse", () => {
    expect(ageFrom({}, NOW)).toBeNull()
    expect(ageFrom(null, NOW)).toBeNull()
    expect(mayDate(ageFrom(null, NOW))).toBe(false)
  })

  it("is null rather than zero", () => {
    // Zero is younger than every min_age and would hide every restricted event
    // from OAuth accounts — the failure the discovery filter avoids on purpose.
    expect(ageFrom({ age: Number.NaN }, NOW)).toBeNull()
  })
})

describe("parseDateOfBirth", () => {
  it("stores the day that was typed, wherever the server runs", () => {
    // `new Date("2000-03-09")` is UTC midnight, which is the 8th in the
    // Americas. Built with Date.UTC so the calendar day survives.
    const d = parseDateOfBirth("2000-03-09", NOW)!
    expect([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]).toEqual([2000, 2, 9])
  })

  it("rejects dates that do not exist", () => {
    // The constructor rolls 31 February forward; the round-trip check catches it.
    expect(parseDateOfBirth("2001-02-31", NOW)).toBeNull()
    expect(parseDateOfBirth("2001-13-01", NOW)).toBeNull()
  })

  it("rejects anything that is not YYYY-MM-DD", () => {
    expect(parseDateOfBirth("09/03/2000", NOW)).toBeNull()
    expect(parseDateOfBirth("2000-3-9", NOW)).toBeNull()
    expect(parseDateOfBirth(20000309, NOW)).toBeNull()
    expect(parseDateOfBirth(null, NOW)).toBeNull()
  })

  it("holds the platform floor at 13", () => {
    // Below it the account cannot exist, so storing the date would create a row
    // the rest of the product refuses to serve.
    expect(parseDateOfBirth("2015-06-15", NOW)).toBeNull()
    expect(parseDateOfBirth("2013-06-15", NOW)).not.toBeNull()
  })

  it("rejects the future and the implausible", () => {
    expect(parseDateOfBirth("2030-01-01", NOW)).toBeNull()
    expect(parseDateOfBirth("1850-01-01", NOW)).toBeNull()
  })
})
