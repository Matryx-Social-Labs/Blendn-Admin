import { NextRequest } from "next/server"

import { successResponse, unauthorizedResponse } from "@/lib/api-response"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { HOME_STATES, LANGUAGES, listCountry, MAX_LANGUAGES, profileListsFor, SIGNS } from "@/lib/about-you"
import { thisOrThatFor, type ThisOrThat } from "@/lib/this-or-that"

const signs = SIGNS.map(({ slug, western, rashi, symbol }) => ({ slug, western, rashi, symbol }))
const questions = (list: readonly ThisOrThat[]) => list.map((q) => ({ slug: q.slug, a: q.a.label, b: q.b.label }))

/**
 * The "about you" vocabulary of matching v2 (plan v2 §8): the lists the
 * profile editor picks from, served for the reason `/work-fields` is — a
 * client copy is every installed build unable to show the next value.
 *
 * - `languages` (besides English in India), at most `maxLanguages`
 * - `homeStates`: the country's regions (India's states and union
 *   territories, Canada's provinces and territories), and "Grew up abroad"
 * - `signs`: each with its Western name and its rashi; the person picks which
 *   calendar is theirs (`sign_system`)
 * - `thisOrThat`: the questions, each with two answers (`a`, `b`); answered
 *   through `PUT /me/this-or-that`
 *
 * Per country (SCRUM-711): `?country=` (a market code, `IN` or `CA`) answers
 * with that country's lists plus `country` and `regionWord` ("state",
 * "province"). Any other value, or an empty one, is the neutral view (every
 * language by name, no regions, only the questions asked everywhere) with
 * `country` and `regionWord` null — never India's. With no `?country=` at all
 * the answer is India's, exactly as installed builds have always read it.
 *
 * Static per URL and identical for everybody, so cached like `/work-fields`.
 */
export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) return unauthorizedResponse("Authentication required")

  const asked = request.nextUrl.searchParams.get("country")
  const response = await successResponse(asked === null ? legacy() : forCountry(listCountry(asked)))
  response.headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
  return response
}

/** India's, in today's shape and key order: installed builds read it byte for byte (fixture in __tests__). */
function legacy() {
  return { languages: LANGUAGES, maxLanguages: MAX_LANGUAGES, homeStates: HOME_STATES, signs, thisOrThat: questions(thisOrThatFor("IN")) }
}

function forCountry(country: ReturnType<typeof listCountry>) {
  const lists = profileListsFor(country)
  return {
    languages: lists.languages,
    maxLanguages: MAX_LANGUAGES,
    homeStates: lists.regions,
    signs,
    thisOrThat: questions(thisOrThatFor(country)),
    country,
    regionWord: lists.regionWord,
  }
}
