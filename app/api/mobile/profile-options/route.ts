import { NextRequest } from "next/server"

import { successResponse, unauthorizedResponse } from "@/lib/api-response"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { HOME_STATES, LANGUAGES, MAX_LANGUAGES, SIGNS } from "@/lib/about-you"
import { THIS_OR_THAT } from "@/lib/this-or-that"

/**
 * The "about you" vocabulary of matching v2 (plan v2 §8): the lists the
 * profile editor picks from, served for the reason `/work-fields` is — a
 * client copy is every installed build unable to show the next value.
 *
 * - `languages` (besides English), at most `maxLanguages`
 * - `homeStates`: states and union territories, and "Grew up abroad"
 * - `signs`: each with its Western name and its rashi; the person picks which
 *   calendar is theirs (`sign_system`)
 * - `thisOrThat`: the twelve questions, each with two answers (`a`, `b`);
 *   answered through `PUT /me/this-or-that`
 *
 * Static and identical for everybody, so cached like `/work-fields`.
 */
export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) return unauthorizedResponse("Authentication required")

  const response = await successResponse({
    languages: LANGUAGES,
    maxLanguages: MAX_LANGUAGES,
    homeStates: HOME_STATES,
    signs: SIGNS.map(({ slug, western, rashi, symbol }) => ({ slug, western, rashi, symbol })),
    thisOrThat: THIS_OR_THAT.map((q) => ({ slug: q.slug, a: q.a.label, b: q.b.label })),
  })
  response.headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
  return response
}
