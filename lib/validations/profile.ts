import { z } from "zod"

import { parseDateOfBirth } from "@/lib/age"
import { isOrientation, orientationsAreCoherent } from "@/lib/dating"
import { isWorkField } from "@/lib/work-fields"

/** Mirrors the `connection_intent` enum in prisma/schema.prisma. */
export const CONNECTION_INTENTS = ["dating", "networking", "friendship", "just_here"] as const

/**
 * "Just here for the event" is exclusive — it cannot be combined.
 *
 * It means "I am not looking to connect", so pairing it with `dating` or
 * `networking` is not a preference, it is a contradiction. The per-event screen
 * enforced this and `about-you` did not, so a real account ended up holding all
 * four at once — which `effectiveIntents` then had to interpret, and which the
 * damping in `lib/matching.ts` reads as a signal it is not.
 *
 * Enforced here rather than on either screen. Two clients agreeing is not a
 * rule; it is two clients that happen to agree until somebody writes a third,
 * or calls the API directly.
 */
export function intentsAreCoherent(intents: readonly string[]): boolean {
  return !(intents.includes("just_here") && intents.length > 1)
}

const intentArray = z
  .array(z.enum(CONNECTION_INTENTS))
  .max(4)
  .refine(intentsAreCoherent, {
    message: "\"Just here for the event\" cannot be combined with anything else",
  })

/** Mirrors the gender values the dating compatibility table understands. */
export const GENDERS = ["woman", "man", "non_binary", "prefer_not_to_say"] as const

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().max(20).optional().nullable(),
  age: z.number().int().min(13).max(120).optional().nullable(),

  /*
   * Birth date as `YYYY-MM-DD`. Write-only — no route returns it.
   *
   * Supersedes `age`, which is a snapshot that starts decaying the day it is
   * taken: someone who signs up at 17 is refused every 18+ event a year later
   * because the column still says 17. `lib/age.ts` explains the precedence.
   *
   * `age` stays accepted rather than being removed, because every row written
   * before this column existed has one and a number cannot be turned back into
   * a date. New clients should send this; old ones keep working.
   *
   * Refused rather than coerced when it does not parse. `parseDateOfBirth`
   * returns `null` for a malformed string, a future date and anything implying
   * an age outside 13–120 — and returning `null` from here would be
   * indistinguishable from "not sent", so a typo would silently store nothing
   * and the person would be told their profile saved.
   *
   * Not nullable: clearing a birth date has no use case, and the accepted way
   * to change one is to send the right one.
   */
  dateOfBirth: z
    .string()
    .refine((value) => parseDateOfBirth(value) !== null, {
      message: "Enter a real date of birth in YYYY-MM-DD form. You must be at least 13.",
    })
    .optional(),
  location: z.string().max(200).optional().nullable(),
  bio: z.string().max(500).optional().nullable(),
  occupation: z.string().max(100).optional().nullable(),
  education: z.string().max(100).optional().nullable(),
  interests: z.array(z.string()).optional(),
  photos: z.array(z.string().url()).max(6).optional(),
  goals: z.array(z.string()).optional(),
  looking_for: z.array(z.string()).optional(),
  onboarded: z.boolean().optional(),

  /*
   * What this person is generally open to, settable from the profile at last.
   *
   * The column has existed since the matchmaking migration and its own schema
   * comment calls it "the default, not the truth" — but the only write path was
   * `PUT /events/:id/matches/preferences` with `remember: true`, which 403s
   * without an existing check-in. So a stable, person-level fact could only be
   * recorded after checking into an event, and the app was forced to ask at
   * check-in for no better reason than that. Per-event override stays where it
   * is; this is the default underneath it.
   */
  intent_default: intentArray.optional(),

  /*
   * Dating inputs. Matching consults them; nobody else ever sees them — they
   * are absent from every non-self response by way of the allow-list in
   * `app/api/mobile/profiles/[userId]/route.ts`, which exists because a
   * deny-list once leaked exactly these two fields.
   *
   * `reveal_by_default` used to be excluded here, with the note "being named
   * has to be something a person did in a room, not a profile setting they
   * flipped once". That reasoning was right and the exclusion was the wrong
   * way to enforce it — see the field below.
   */
  gender: z.enum(GENDERS).optional().nullable(),
  interested_in: z.array(z.enum(GENDERS)).max(4).optional(),

  /**
   * How you would *like* to enter a room: named, or as a pseudonym.
   *
   * ## Why this is settable now, when it deliberately was not
   *
   * The rule being protected is **revealing must be a deliberate act in the
   * room**, and the old enforcement was to make this field unwritable — so the
   * only way to be named was to tap it, per event, every time.
   *
   * That protected the rule and broke the product. Someone who is happy to be
   * seen had to re-answer the same question at every door, and someone who
   * wanted to stay anonymous was never told what state they were in.
   *
   * The rule is now enforced where it belongs, in three places that did not
   * exist when the field was locked:
   *
   *  1. **This is a suggestion, not an application.** Check-in already returns
   *     it as `revealSuggestion` and creates the row with `revealed: false`
   *     regardless. Being named still takes a tap, every time.
   *  2. **A warning the first time.** Entering a room publicly shows what that
   *     means before it happens, once.
   *  3. **A banner, always.** The room says which state you are in for as long
   *     as you are in it, so "flipped it once and forgot" stops being possible.
   *
   * A setting nobody can see is worse than a setting with a warning on it. The
   * old design had the first; this has the second.
   *
   * Still defaults false. Anonymous remains what happens when you do nothing.
   */
  reveal_by_default: z.boolean().optional(),

  /*
   * Show `orientation` to people who can already see who you are.
   *
   * Not "make it public" — even on, the value only reaches callers who pass
   * `maySeeIdentity`. This app withholds someone's real name and face from
   * anyone who has not matched, opened a conversation, or been revealed to, so
   * a field more sensitive than a name cannot be less protected than one.
   *
   * A different question from `reveal_by_default` above, and worth keeping
   * apart: that one is a *suggestion* the room re-asks by way of a tap, while
   * this one takes effect the moment it is saved. Whether an attribute already
   * on your profile is visible to people you have matched with is exactly the
   * kind of thing a profile setting is for; being named in a room is not.
   */
  show_orientation: z.boolean().optional(),

  /*
   * The labels they hold. `interested_in` is what matching reads, and the route
   * derives it from this pair *only when the request does not supply it* —
   * client-supplied always wins. Two writers to one column with no precedence
   * is how a hand-picked preference gets replaced by a derived empty set.
   *
   * Coherence is one refine rather than three chained ones so the message names
   * the actual rule. `.max(3)` alone would answer "prefer not to say plus gay"
   * with "at most 3", which is true and unhelpful.
   */
  orientations: z
    .array(z.string())
    .refine(orientationsAreCoherent, {
      message:
        "Up to three distinct recognised orientations, and 'prefer not to say' cannot be combined with others",
    })
    .optional(),

  /*
   * The singular, still accepted, writing into the array above.
   *
   * `orientations` replaced it and every client should send the array. This
   * stays because the failure mode of removing it is silent: an installed build
   * would keep sending `orientation`, zod would drop the unknown key, and the
   * save would succeed while storing nothing. A rejected request is visible; a
   * successful one that discards a field is not.
   *
   * Remove once no build in the field sends it.
   */
  orientation: z
    .string()
    .refine(isOrientation, { message: "Not a recognised orientation" })
    .optional()
    .nullable(),

  /*
   * Coarse field of work — a slug the server owns, never free text.
   *
   * Validated against the list rather than as a string, because
   * `profiles.interests` is the counter-example sitting in the same table:
   * free text, so "Software" and "software engineering" never match, and the
   * fix was two PRs. `GET /api/mobile/work-fields` serves the same list, so a
   * client cannot invent a nineteenth value and discover it silently stored.
   *
   * Nullable: clearing it has to be possible, and unlike the four preference
   * booleans there is no sensible default to fall back to.
   */
  work_field: z
    .string()
    .refine(isWorkField, { message: "Not a recognised field of work" })
    .optional()
    .nullable(),

  // Settings the app has always shown and never stored. Four switches with no
  // columns behind them meant every toggle read ON regardless of what anyone
  // chose.
  push_enabled: z.boolean().optional(),
  show_online: z.boolean().optional(),
  read_receipts: z.boolean().optional(),
  share_location: z.boolean().optional(),
})

export const addInterestsSchema = z.object({
  categoryIds: z.array(z.string().uuid("Invalid category ID")).min(1, "At least one category is required"),
})

export const removeInterestsSchema = z.object({
  categoryIds: z.array(z.string().uuid("Invalid category ID")).min(1, "At least one category is required"),
})

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
export type AddInterestsInput = z.infer<typeof addInterestsSchema>
export type RemoveInterestsInput = z.infer<typeof removeInterestsSchema>
