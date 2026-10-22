import { NextRequest } from "next/server"

import { successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { eventSession, sessionOccurrencesSelect } from "@/lib/occurrences"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { parsePagination, paginationMeta, paginationSkip } from "@/lib/pagination"
import { realEventsWhere } from "@/lib/event-kind"

export const dynamic = "force-dynamic"

/**
 * The events you said you are going to.
 *
 * The app's Going tab listed favourites — the heart — and nothing else,
 * because no route returned a person's RSVPs: `event_rsvps` was read one row at
 * a time, on the event screen. So somebody who tapped "I'm going" opened the
 * tab called Going and did not find the event there.
 *
 * ## Why `/me`
 *
 * Where somebody is going, and on which nights, is the same correlation
 * `/me/attendance` refuses to expose for anyone but the caller, only in the
 * future tense — it is the more dangerous of the two. Scoped by construction:
 * no id in the path, nothing to check and forget.
 *
 * ## What is listed
 *
 * `going` and `waitlisted`, because both are a commitment the person made and
 * both are what they would look for; `rsvpStatus` says which, so the app can
 * say "Waitlist" rather than let somebody believe they have a place. Not
 * `maybe` or `not_going`. Events that have not ended, soonest first. Cancelled
 * events stay, with their status, so the cancellation is seen rather than the
 * event silently disappearing; drafts and deleted events do not.
 *
 * The event fields are the favourites route's names, so the app reads both
 * lists with one row builder.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const { searchParams } = new URL(request.url)
    const { page, limit } = parsePagination(
      searchParams.get("page") ?? undefined,
      searchParams.get("limit") ?? undefined
    )

    const where = {
      user_id: authUser.userId,
      status: { in: ["going" as const, "waitlisted" as const] },
      event: {
        deleted_at: null,
        // A venue day takes no RSVP; going live is the only way in (F7).
        ...realEventsWhere,
        status: { not: "draft" as const },
        end_time: { gte: new Date() },
      },
    }

    const [rsvps, totalCount] = await Promise.all([
      db.event_rsvps.findMany({
        where,
        select: {
          status: true,
          created_at: true,
          event: {
            select: {
              id: true,
              slug: true,
              title: true,
              cover_image_url: true,
              start_time: true,
              end_time: true,
              occurrences: sessionOccurrencesSelect,
              timezone: true,
              status: true,
              venue_name: true,
              address: true,
              city: true,
              latitude: true,
              longitude: true,
              media: { orderBy: { order: "asc" }, take: 1 },
            },
          },
        },
        orderBy: { event: { start_time: "asc" } },
        skip: paginationSkip(page, limit),
        take: limit,
      }),
      db.event_rsvps.count({ where }),
    ])

    const events = rsvps.map(({ status, created_at, event }) => ({
      id: event.id,
      slug: event.slug,
      title: event.title,
      coverImageUrl: event.cover_image_url,
      coverImage: event.media[0] ?? null,
      startTime: event.start_time,
      endTime: event.end_time,
      // The Going tab's "Happening now" reads this, not the run. See `eventSession`.
      session: eventSession(event),
      timezone: event.timezone,
      status: event.status,
      venueName: event.venue_name,
      address: event.address,
      city: event.city,
      latitude: event.latitude,
      longitude: event.longitude,
      rsvpStatus: status,
      rsvpAt: created_at,
    }))

    return successResponse({
      events,
      pagination: paginationMeta(page, limit, totalCount),
    })
  } catch (error) {
    logger.error("Get own RSVPs failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load your RSVPs")
  }
}
