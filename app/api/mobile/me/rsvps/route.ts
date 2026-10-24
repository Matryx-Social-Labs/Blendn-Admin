import { NextRequest } from "next/server"

import { errorResponse, successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { eventSession, sessionOccurrencesSelect } from "@/lib/occurrences"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { keysetPage, pagedPagination, paginationSkip, parsePageOrCursor } from "@/lib/pagination"
import { isUuid } from "@/lib/api-input"
import { realEventsWhere } from "@/lib/event-kind"
import { changeSelect, changeSummaryForResponse } from "@/lib/event-change"

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
 * `?page=` and `?limit=` as before; `?cursor=` (the last page's
 * `pagination.nextCursor`) pages by keyset on start time then id, and a cursor
 * that is not ours is a 400. Neither of the three is an installed build that
 * cannot page, and gets up to 200 (`LEGACY_PAGE`). `totalCount` is the list.
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

    const query = parsePageOrCursor(new URL(request.url).searchParams, isUuid)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit } = query

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

    // Soonest first, then by id: two events starting at the same minute never swap or repeat across a page.
    const afterCursor =
      query.mode === "cursor"
        ? {
            OR: [
              { event: { start_time: { gt: query.after.at } } },
              { event: { start_time: query.after.at }, id: { gt: query.after.id } },
            ],
          }
        : null

    const [rows, totalCount] = await Promise.all([
      db.event_rsvps.findMany({
        where: afterCursor ? { AND: [where, afterCursor] } : where,
        select: {
          id: true,
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
              visibility: true,
              venue_name: true,
              address: true,
              city: true,
              latitude: true,
              longitude: true,
              ...changeSelect,
              media: { orderBy: { order: "asc" }, take: 1 },
              // As `GET /users/:id/favorites` sends them: the app draws a row's category plate from these.
              categories: { select: { category: { select: { id: true, name: true, slug: true, icon: true } } } },
            },
          },
        },
        orderBy: [{ event: { start_time: "asc" } }, { id: "asc" }],
        skip: query.mode === "page" ? paginationSkip(query.page, limit) : 0,
        take: limit + 1,
      }),
      db.event_rsvps.count({ where }),
    ])
    const paged = keysetPage(rows, limit, (r) => ({ at: r.event.start_time, id: r.id }))
    const rsvps = paged.items

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
      visibility: event.visibility,
      venueName: event.venue_name,
      address: event.address,
      city: event.city,
      latitude: event.latitude,
      longitude: event.longitude,
      // What moved under you while you were going: the event read's values, from the same helper.
      ...changeSummaryForResponse(event),
      rsvpStatus: status,
      rsvpAt: created_at,
      categories: event.categories.map((c) => c.category),
    }))

    return successResponse({
      events,
      pagination: pagedPagination(query, totalCount, paged),
    })
  } catch (error) {
    logger.error("Get own RSVPs failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load your RSVPs")
  }
}
