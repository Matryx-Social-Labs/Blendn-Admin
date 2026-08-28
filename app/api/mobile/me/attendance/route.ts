import { NextRequest } from "next/server"

import { attendedEventIds, distinctEventsAttended } from "@/lib/attendee-counts"
import { successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { parsePagination, paginationMeta, paginationSkip } from "@/lib/pagination"

export const dynamic = "force-dynamic"

/**
 * The events behind the number.
 *
 * A profile has said "7 events attended" since the stat existed, and there was
 * no way to see which seven — the data and both indexes were already there
 * (`@@index([user_id, status])`) and nothing queried it that way. One integer,
 * unexpandable.
 *
 * ## Why it is `/me` and not `/users/:id/attendance`
 *
 * Attendance history is the sharpest correlation this product holds: where
 * somebody was, on which nights, at which venues. It is the record the whole
 * pseudonym design exists to keep from being assembled, and TR4 rejected
 * putting it on a chain for exactly that reason — *"a stalking primitive, in a
 * product whose pseudonym design exists to prevent exactly that correlation"*.
 *
 * So it is scoped to the caller by construction rather than by a check. There
 * is no id in the path to get wrong, no `maySeeIdentity` decision to forget,
 * and no future PR that widens it by accident. Somebody else's attendance is
 * not a thing this endpoint can be asked for.
 *
 * ## One list, one definition
 *
 * The rows come from `lib/attendee-counts.ts`, beside the count they explain
 * and sharing its predicate. "You attended 7 events" above a list of 9 is worse
 * than either number alone, because it teaches the reader to trust neither.
 *
 * Events are returned once each, however many days somebody turned up for —
 * `event_check_ins` holds a row per person per occurrence, and counting those
 * as events is what told a three-day-conference attendee they had been to three
 * events (I1).
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

    const [attended, totalCount] = await Promise.all([
      attendedEventIds(authUser.userId, { limit, skip: paginationSkip(page, limit) }),
      distinctEventsAttended(authUser.userId),
    ])

    /*
     * Deleted events are filtered here rather than in the count, on purpose:
     * the count answers "how many did you go to", which a later deletion does
     * not change. A page that renders fewer cards than its total is the honest
     * shape when the missing one is an event the platform removed.
     */
    const events = attended.length
      ? await db.events.findMany({
          where: { id: { in: attended.map((a) => a.event_id) }, deleted_at: null },
          select: {
            id: true,
            slug: true,
            title: true,
            cover_image_url: true,
            start_time: true,
            end_time: true,
            venue_name: true,
            city: true,
          },
        })
      : []

    // Back into attendance order. `findMany` returns rows in whatever order
    // Postgres likes, and the useful order is the one the query above chose.
    const byId = new Map(events.map((e) => [e.id, e]))
    const rows = attended
      .map((a) => {
        const event = byId.get(a.event_id)
        return event ? { ...event, attendedAt: a.first_seen } : null
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)

    return successResponse({
      events: rows,
      pagination: paginationMeta(page, limit, totalCount),
    })
  } catch (error) {
    logger.error("Get own attendance failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load your attendance")
  }
}
