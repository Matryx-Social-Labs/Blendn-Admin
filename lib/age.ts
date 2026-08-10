/**
 * Age rules, in one file, because they are enforced in five places.
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
