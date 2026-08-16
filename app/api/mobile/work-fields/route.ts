import { NextRequest } from "next/server"

import { successResponse, unauthorizedResponse } from "@/lib/api-response"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { EXPERTISE_BY_FIELD, MAX_EXPERTISE } from "@/lib/expertise"
import { WORK_FIELDS } from "@/lib/work-fields"

/**
 * The list of coarse work fields, served rather than hardcoded in the client.
 *
 * The interests taxonomy is the reason this endpoint exists. It began as free
 * text typed into the app, so "Software" and "software engineering" were two
 * different things that could never match, and unpicking it cost two PRs —
 * `profiles.interests` is still in the schema with `lib/interest-coverage.ts`
 * beside it to warn that nothing reads it. A hardcoded copy in the app is the
 * same failure a step later: the day a nineteenth bucket is added, every
 * installed build is a client that cannot show it and cannot send it.
 *
 * Authenticated for consistency with `/categories`, not because the list is
 * secret. It is eighteen strings, identical for everybody, and the response is
 * safe to cache for a long time — hence the immutable-ish `max-age`, with
 * `stale-while-revalidate` so a new bucket appears without anyone waiting.
 *
 * ## The specialisms ride along
 *
 * `expertiseByField` is served here rather than from a second endpoint, and
 * that is deliberate: the picker is one question in two steps — field, then
 * what you do within it — and a client that has the first and not the second
 * has to make a request between two taps of the same screen. It is a few
 * kilobytes of static strings on a response already cached for an hour.
 *
 * Keyed by the same slugs as `workFields`, so the client indexes rather than
 * matching. `other` is present with an empty array on purpose — a missing key
 * and a knowingly empty one must not look the same to a client deciding whether
 * to draw the step at all.
 */
export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) return unauthorizedResponse("Authentication required")

  const response = await successResponse({
    workFields: WORK_FIELDS,
    expertiseByField: EXPERTISE_BY_FIELD,
    maxExpertise: MAX_EXPERTISE,
  })
  response.headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
  return response
}
