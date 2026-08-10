import { z } from "zod"

import { isOrientation } from "@/lib/dating"
import { isWorkField } from "@/lib/work-fields"

/** Mirrors the `connection_intent` enum in prisma/schema.prisma. */
export const CONNECTION_INTENTS = ["dating", "networking", "friendship", "just_here"] as const

/** Mirrors the gender values the dating compatibility table understands. */
export const GENDERS = ["woman", "man", "non_binary", "prefer_not_to_say"] as const

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().max(20).optional().nullable(),
  age: z.number().int().min(13).max(120).optional().nullable(),
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
  intent_default: z.array(z.enum(CONNECTION_INTENTS)).max(4).optional(),

  /*
   * Dating inputs. Matching consults them; nobody else ever sees them — they
   * are absent from every non-self response by way of the allow-list in
   * `app/api/mobile/profiles/[userId]/route.ts`, which exists because a
   * deny-list once leaked exactly these two fields.
   *
   * `reveal_by_default` is deliberately NOT here. Being named has to be
   * something a person did in a room, not a profile setting they flipped once.
   */
  gender: z.enum(GENDERS).optional().nullable(),
  interested_in: z.array(z.enum(GENDERS)).max(4).optional(),

  /*
   * The label they hold. `interested_in` is what matching reads, and the route
   * derives it from this pair *only when the request does not supply it* —
   * client-supplied always wins. Two writers to one column with no precedence
   * is how a hand-picked preference gets replaced by a derived empty set.
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
