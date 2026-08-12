import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { PAGINATION } from "@/lib/constants"

const searchSchema = z.object({
  q: z.string().min(1).max(200),
  /**
   * Scope search to the browsed city, the same way `GET /events` does.
   *
   * Optional so an explicit "search everywhere" stays possible, but the app
   * sends it: a home screen scoped to Bengaluru whose search box silently
   * returns Delhi results reads as a bug in the search, not as a feature.
   */
  city: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
})

export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const params = Object.fromEntries(request.nextUrl.searchParams)
    const parsed = searchSchema.safeParse(params)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { q, city, page, limit } = parsed.data
    const offset = (page - 1) * limit

    // Sanitize query for PostgreSQL - escape special characters
    const sanitized = q.replace(/[&|!():*'"\\]/g, " ").trim()
    if (!sanitized) {
      return successResponse({ events: [], pagination: { page, limit, totalCount: 0, totalPages: 0, hasMore: false } })
    }

    // Build tsquery from words (prefix matching with :*)
    const tsquery = sanitized
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => `${word}:*`)
      .join(" & ")

    /*
     * The same age filter the listing applies — search is the other way in.
     *
     * A filter on one of two discovery surfaces is decoration: typing the name
     * of an 18+ event would otherwise return it to a 15-year-old that the feed
     * had just finished hiding it from.
     *
     * Parameterised, like the tsquery: this file is `$queryRawUnsafe`, and an
     * age interpolated into the string would be the one injection point in it.
     * `NULL` for an unknown age makes both comparisons below fall through to
     * `min_age IS NULL`... which would hide every restricted event, so the
     * predicate is written to pass everything when the parameter is null.
     */
    const viewer = await db.profiles.findUnique({
      where: { id: authUser.userId },
      select: { age: true },
    })
    const viewerAge = typeof viewer?.age === "number" ? viewer.age : null
    // The two queries below bind a different number of parameters, so the
    // placeholder index is passed in rather than hardcoded — getting it wrong
    // is a runtime error on a rarely-exercised path.
    const ageFilter = (n: number) =>
      `AND ($${n}::int IS NULL OR min_age IS NULL OR min_age <= $${n}::int)`

    /*
     * Same shape and the same reasoning as the age filter: bound, never
     * interpolated, and written to pass everything when the parameter is null
     * so an absent `city` widens the search instead of emptying it.
     *
     * `lower(...)` on both sides matches the case-insensitive filter in
     * `../route.ts`. It costs a sequential scan on `city`, which is fine here —
     * the tsquery predicate is what selects rows, and this only narrows them.
     */
    const cityFilter = (n: number) =>
      `AND ($${n}::text IS NULL OR lower(city) = lower($${n}::text))`
    const cityParam = city ?? null

    // Full-text search with ranking
    const events = await db.$queryRawUnsafe<Array<{
      id: string
      slug: string
      title: string
      short_description: string | null
      cover_image_url: string | null
      start_time: Date
      end_time: Date
      venue_name: string | null
      city: string | null
      status: string
      rank: number
    }>>(
      `SELECT id, slug, title, short_description, cover_image_url,
              start_time, end_time, venue_name, city, status,
              ts_rank(
                to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(venue_name, '') || ' ' || coalesce(city, '')),
                to_tsquery('english', $1)
              ) as rank
       FROM events
       WHERE deleted_at IS NULL
         AND status = 'published'
         AND visibility = 'public'
         ${ageFilter(4)}
         ${cityFilter(5)}
         AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(venue_name, '') || ' ' || coalesce(city, ''))
             @@ to_tsquery('english', $1)
       ORDER BY rank DESC, start_time ASC
       LIMIT $2 OFFSET $3`,
      tsquery,
      limit,
      offset,
      viewerAge,
      cityParam
    )

    const countResult = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) as count
       FROM events
       WHERE deleted_at IS NULL
         AND status = 'published'
         AND visibility = 'public'
         ${ageFilter(2)}
         ${cityFilter(3)}
         AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(venue_name, '') || ' ' || coalesce(city, ''))
             @@ to_tsquery('english', $1)`,
      tsquery,
      viewerAge,
      cityParam
    )

    const totalCount = Number(countResult[0]?.count ?? 0)

    return successResponse({
      events: events.map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        shortDescription: e.short_description,
        coverImageUrl: e.cover_image_url,
        startTime: e.start_time,
        endTime: e.end_time,
        venueName: e.venue_name,
        city: e.city,
        status: e.status,
      })),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    logger.error("Event search error", { error: error instanceof Error ? error.message : String(error) })
    // Fallback to ILIKE if full-text search fails (e.g., tsvector not available)
    return serverErrorResponse("Search failed")
  }
}
