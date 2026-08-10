/**
 * Who is plausibly a dating match for whom.
 *
 * Until now `lib/matches.ts` never read gender at all, so a straight man who
 * ticked dating got "Both open to dating" on cards for other straight men. Not
 * a leak and not dangerous — just wrong, in the way that makes a feature read
 * as broken and stop being used.
 *
 * ## A tag filter, not a pool filter
 *
 * Everyone stays in the list. What changes is whether `dating` appears as a
 * *shared intent* between two people. Two men who both ticked dating still
 * match on interests and on networking; they simply are not told they are a
 * dating match.
 *
 * That is deliberate and it is the whole design. `matching.ts:47` calls a hard
 * filter here "the partition the one-pool decision exists to avoid" — a room is
 * a room, and removing people from it because of an attribute nobody can see is
 * how you end up with four half-empty rooms instead of one full one. It also
 * means a card reading "Both open to dating" has already had compatibility
 * checked, so it never has to state anyone's gender to be accurate.
 *
 * ## Orientation labels do not compose with non-binary genders
 *
 * "Straight" plus "non-binary" has no defined target set. Neither does
 * "gay plus prefer-not-to-say". Every implementation that pretends otherwise is
 * guessing about someone's dating life, which is a strange thing for a server
 * to do and an insulting one to get wrong.
 *
 * So `deriveInterestedIn` covers only the combinations that mean something
 * unambiguous and returns `null` for the rest — and `null` means **ask**, not
 * "assume". The onboarding screen shows an "interested in" picker instead.
 *
 * ## Client-supplied always wins
 *
 * When a request carries `interested_in`, it is stored as given and derivation
 * never runs. Two writers to one column with no precedence is exactly how a
 * hand-picked preference gets silently replaced by a derived empty set.
 *
 * ## Anything undeclared fails closed
 *
 * Missing gender, missing `interested_in`, missing anything: no dating tag,
 * person still listed. The failure mode of guessing is showing someone a match
 * that is not one; the failure mode of failing closed is a card that says one
 * fewer true thing. The second is obviously better.
 */

import type { GENDERS } from "@/lib/validations/profile"

export type Gender = (typeof GENDERS)[number]

/**
 * Orientation labels the profile accepts.
 *
 * `pansexual` and `queer` are here as identities people hold, not as things
 * this file can derive from — both land in the "ask directly" branch below.
 * `prefer_not_to_say` likewise: a person may want it on their profile without
 * it implying anything about who they want to meet.
 */
export const ORIENTATIONS = [
  "straight",
  "gay",
  "lesbian",
  "bisexual",
  "pansexual",
  "queer",
  "asexual",
  "prefer_not_to_say",
] as const

export type Orientation = (typeof ORIENTATIONS)[number]

export function isOrientation(value: unknown): value is Orientation {
  return typeof value === "string" && (ORIENTATIONS as readonly string[]).includes(value)
}

/**
 * The target set implied by a (gender, orientation) pair — or `null` when the
 * pair implies nothing definite and the person has to be asked.
 *
 * `null` is returned far more often than a naive table would return it, and
 * that is the point. The cases below are the ones where the label has a settled
 * meaning; everything else goes to a direct picker.
 */
export function deriveInterestedIn(
  gender: Gender | null | undefined,
  orientation: Orientation | null | undefined
): Gender[] | null {
  if (!gender || !orientation) return null

  // Nobody, and that is a complete answer rather than a missing one. Someone
  // asexual who ticked dating is looking for something these tags do not model,
  // so no dating tag is the honest result.
  if (orientation === "asexual") return []

  // An identity, not a target set. Both need the direct picker.
  if (orientation === "pansexual" || orientation === "queer") return null
  if (orientation === "prefer_not_to_say") return null

  // "Straight" and "gay" are defined relative to a binary the other two gender
  // values are not in. Deriving for them would be inventing a meaning.
  if (gender === "non_binary" || gender === "prefer_not_to_say") {
    return orientation === "bisexual" ? ["woman", "man", "non_binary"] : null
  }

  switch (orientation) {
    case "straight":
      return gender === "woman" ? ["man"] : ["woman"]
    case "gay":
      // Held by men and, commonly, by women who prefer it to "lesbian".
      return gender === "man" ? ["man"] : ["woman"]
    case "lesbian":
      return ["woman"]
    case "bisexual":
      return ["woman", "man", "non_binary"]
  }
}

export interface DatingProfile {
  gender: Gender | null
  interestedIn: Gender[]
}

/**
 * Are these two plausibly a dating match?
 *
 * Mutual by construction: A must be someone B is open to *and* B must be
 * someone A is open to. A one-sided check would put "Both open to dating" on a
 * card where only one side means it.
 *
 * Fails closed on anything missing. An empty `interestedIn` is a real answer
 * (see `asexual` above) and reads the same as an absent one here — in both
 * cases there is no evidence of a match, and the tag is the thing being
 * claimed.
 */
export function matchCompatibleForDating(a: DatingProfile, b: DatingProfile): boolean {
  if (!a.gender || !b.gender) return false
  if (!a.interestedIn?.length || !b.interestedIn?.length) return false
  return a.interestedIn.includes(b.gender) && b.interestedIn.includes(a.gender)
}
