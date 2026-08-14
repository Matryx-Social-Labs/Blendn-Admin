/**
 * Age rules, and where the age itself comes from.
 *
 * The rules below all take an age. `ageFrom` at the bottom of this file is how
 * that number is obtained, and every caller should go through it rather than
 * reading `profiles.age` directly — see its comment for why a stored age is a
 * fact with an expiry date on it.
 *
 * Two separate rules that both happen to be about age:
 *
 *  1. **Dating intent requires 18.** `profiles.age` accepts 13, and until now
 *     nothing anywhere connected the two — a 14-year-old could tick "open to
 *     dating" and be ranked into the same pool as adults, on a card that says
 *     "Both open to dating". The floor stays 13 for the product; it is the
 *     dating tag that is gated, not the account.
 *
 *  2. **An event can require a minimum age.** A club night is 18+ or 21+
 *     whatever anyone ticked, and the organiser is the one who knows.
 *
 * Both **fail closed on an unknown age**, which is the whole reason these are
 * functions rather than inline comparisons. `age` is nullable and OAuth
 * accounts are created without one, so `age < 18` is `null < 18` is `true` in
 * JavaScript — the naive check lets exactly the unknown case through. Written
 * once, tested once, and the five call sites cannot each get it wrong
 * differently.
 */

export const DATING_MIN_AGE = 18

/** Every intent that is gated on age. `dating` is currently the only one. */
const AGE_GATED_INTENTS = ["dating"] as const

/**
 * May this account carry `dating` as an intent?
 *
 * Unknown age is a no. That is a real refusal for OAuth users, who have no age
 * until the app asks for one — and the alternative is a pool where "we do not
 * know how old you are" is treated as "you are an adult".
 */
export function mayDate(age: number | null | undefined): boolean {
  return typeof age === "number" && age >= DATING_MIN_AGE
}

/**
 * Why this set of intents is refused, or `null` if it is allowed.
 *
 * Returns prose because every caller shows it to the person: a refusal that
 * does not say what rule was broken reads as a bug, and the two cases need
 * different actions from the user — one adds their age, the other cannot
 * proceed at all.
 */
export function datingAgeRefusal(
  intents: readonly string[] | undefined,
  age: number | null | undefined
): string | null {
  if (!intents?.some((i) => (AGE_GATED_INTENTS as readonly string[]).includes(i))) return null
  if (mayDate(age)) return null
  return age == null
    ? "Add your age to your profile before choosing dating."
    : `Dating is for ${DATING_MIN_AGE}+ only. Your other choices are fine.`
}

/**
 * The same intents with `dating` removed when the account may not carry it.
 *
 * For the paths that seed rather than accept — check-in copies
 * `profiles.intent_default` onto the check-in row, and a profile written before
 * this rule existed can still hold `dating`. Dropping it quietly is right there:
 * the person is not making a choice at that moment, and refusing the check-in
 * over a stale profile field would keep them out of the room entirely.
 */
export function stripDating<T extends string>(
  intents: readonly T[],
  age: number | null | undefined
): T[] {
  if (mayDate(age)) return [...intents]
  return intents.filter((i) => !(AGE_GATED_INTENTS as readonly string[]).includes(i))
}

/**
 * Why this account cannot check in to an event with this minimum age, or `null`.
 *
 * `minAge` null means the event has no restriction, which is almost all of
 * them. An unknown age is refused, and the message says which of the two things
 * to do about it.
 */
export function minAgeRefusal(
  age: number | null | undefined,
  minAge: number | null | undefined
): string | null {
  if (minAge == null) return null
  if (typeof age === "number" && age >= minAge) return null
  return age == null
    ? `This event is ${minAge}+. Add your age to your profile to check in.`
    : `This event is ${minAge}+.`
}

/* -------------------------------------------------------------------------- */
/* Where the age comes from                                                    */
/* -------------------------------------------------------------------------- */

export interface AgeSource {
  date_of_birth?: Date | string | null
  age?: number | null
}

/**
 * How old someone is, right now.
 *
 * `profiles.age` was captured at signup, so it is wrong the day after and gets
 * wronger. Against the rules above that decay is silent and lands on exactly
 * the people they exist for: someone who signs up at 17 stays 17 in the table
 * forever, so `minAgeRefusal` keeps refusing them a year later — and someone
 * who typed 18 at 17 stays 18 with nothing to re-derive from.
 *
 * A birth date does not go stale. `date_of_birth` wins when present; `age` is
 * the fallback for every row written before the column existed, because a
 * number cannot be turned back into a date.
 *
 * **The date never leaves the server.** It is materially more identifying than
 * an age — a standard security-question answer, and half of an identity-theft
 * pair — so no route returns it and this is the only function that reads it.
 *
 * Returns `null` when we genuinely do not know, which the rules above already
 * treat as a refusal. Not zero: zero is younger than every `min_age` and would
 * hide every restricted event from OAuth accounts, which is the failure the
 * discovery filter deliberately avoids.
 *
 * `now` is injectable so the birthday boundary is testable without waiting a
 * year for it.
 */
export function ageFrom(source: AgeSource | null | undefined, now: Date = new Date()): number | null {
  if (!source) return null

  const dob = toDate(source.date_of_birth)
  if (dob) {
    const years = wholeYearsBetween(dob, now)
    // A future or implausible date is corrupt rather than informative. Falling
    // through to the stored number beats returning a negative age, which would
    // satisfy every `age >= minAge` comparison in this file.
    if (years >= 0 && years < 150) return years
  }

  return typeof source.age === "number" && Number.isFinite(source.age) ? source.age : null
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Whole years between two dates, in UTC.
 *
 * UTC on both sides deliberately. `date_of_birth` is a bare date, so reading it
 * in the server's local zone shifts it by a day for anyone born near midnight —
 * and one day either side of a birthday is the difference between 17 and 18 for
 * exactly the people the gate is for.
 *
 * The month/day comparison is what makes it *whole* years: subtracting the year
 * numbers alone would make someone 18 on the 1st of January of the year they
 * turn 18, up to twelve months early.
 */
function wholeYearsBetween(from: Date, to: Date): number {
  let years = to.getUTCFullYear() - from.getUTCFullYear()
  const monthDiff = to.getUTCMonth() - from.getUTCMonth()
  const dayDiff = to.getUTCDate() - from.getUTCDate()
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years -= 1
  return years
}

/**
 * Parse a `YYYY-MM-DD` from a client into a date safe to store.
 *
 * `null` for anything malformed, in the future, or implying an age outside
 * 13–120. The floor matches the platform minimum — an account below it cannot
 * exist, so storing the date would create a row the rest of the product refuses
 * to serve.
 *
 * Built with `Date.UTC` rather than `new Date("YYYY-MM-DD")` so the stored day
 * is the day that was typed, wherever the server runs.
 */
export function parseDateOfBirth(input: unknown, now: Date = new Date()): Date | null {
  if (typeof input !== "string") return null

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const date = new Date(Date.UTC(year, month - 1, day))

  // Catches 31 February and friends: the constructor rolls them forward, so a
  // round-trip mismatch means it was never a real calendar date.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  const years = wholeYearsBetween(date, now)
  return years < 13 || years > 120 ? null : date
}
