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

    const { q, page, limit } = parsed.data
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
         AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(venue_name, '') || ' ' || coalesce(city, ''))
             @@ to_tsquery('english', $1)
       ORDER BY rank DESC, start_time ASC
       LIMIT $2 OFFSET $3`,
      tsquery,
      limit,
      offset
    )

    const countResult = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) as count
       FROM events
       WHERE deleted_at IS NULL
         AND status = 'published'
         AND visibility = 'public'
         AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(venue_name, '') || ' ' || coalesce(city, ''))
             @@ to_tsquery('english', $1)`,
      tsquery
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
    console.error("Event search error:", error)
    // Fallback to ILIKE if full-text search fails (e.g., tsvector not available)
    return serverErrorResponse("Search failed")
  }
}
