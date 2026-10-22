import { NextRequest } from "next/server"

import { attendedEventIds, distinctEventsAttended } from "@/lib/attendee-counts"
import { errorResponse, successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { stayMinutesByEvent } from "@/lib/presence-sessions"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { keysetPage, pagedPagination, paginationSkip, parsePageOrCursor, type PagedQuery } from "@/lib/pagination"
import { isUuid } from "@/lib/api-input"
import { lockedNights } from "@/lib/plus"

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
 *
 * ## The free nights and the rest (Blendn+, step 11)
 *
 * Where Blendn+ is gated, a person without it sees their latest
 * `PLUS.FREE_HISTORY_NIGHTS` (3) and `lockedCount` says how many more there
 * are; the pages stop at the third. The count on the profile stays the true
 * one — how many nights is theirs to know; the list of where is the Plus part.
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

    const skip = query.mode === "page" ? paginationSkip(query.page, limit) : 0
    const totalCount = await distinctEventsAttended(authUser.userId, { places: true })
    const lockedCount = await lockedNights(authUser.userId, totalCount)
    const visible = totalCount - lockedCount
    // Where Plus gates, `visible` is the free few: read just those and page them here, the cursor included.
    const read =
      lockedCount > 0
        ? afterThePosition(await attendedEventIds(authUser.userId, { limit: visible, skip: 0 }), query)
        : await attendedEventIds(authUser.userId, {
            limit: limit + 1,
            skip,
            ...(query.mode === "cursor" && { after: query.after }),
          })
    const paged = keysetPage(read, limit, (r) => ({ at: r.first_seen, id: r.event_id }))
    const attended = paged.items

    // Deleted events are already out of both queries (SCRUM-432). This filter
    // only covers one deleted between the two reads.
    const events = attended.length
      ? await db.events.findMany({
          // any-kind: your own nights include the places you went live at —
          // venue days stay in your history, labelled as places (D-6).
          where: { id: { in: attended.map((a) => a.event_id) }, deleted_at: null },
          select: {
            id: true,
            // `event` or `venue_day`: the app labels a venue day as a place
            // (D-6) — its title is bookkeeping, its `venue_name` is the place.
            kind: true,
            slug: true,
            title: true,
            cover_image_url: true,
            start_time: true,
            end_time: true,
            venue_name: true,
            city: true,
            venue_id: true,
            // What kind of place a visit was, from the row already being read.
            venue: { select: { venue_type: true } },
          },
        })
      : []

    // A visit's length, for the venue days on this page only: one grouped read, never one per row.
    const stays = await stayMinutesByEvent(
      authUser.userId,
      events.filter((e) => e.kind === "venue_day").map((e) => e.id)
    )

    // Whether you rated each night: one grouped read for the page, `GET /events/:id/rating`'s `ratedAt`.
    const rated = await db.event_ratings.findMany({
      where: { user_id: authUser.userId, event_id: { in: events.filter((e) => e.kind === "event").map((e) => e.id) } },
      select: { event_id: true, updated_at: true },
    })
    const ratedAt = new Map(rated.map((r) => [r.event_id, r.updated_at]))

    // Back into attendance order. `findMany` returns rows in whatever order
    // Postgres likes, and the useful order is the one the query above chose.
    const byId = new Map(events.map((e) => [e.id, e]))
    const rows = attended
      .map((a) => {
        const event = byId.get(a.event_id)
        if (!event) return null
        const { venue_id, venue, ...shown } = event
        const visit = event.kind === "venue_day"
        // Only a visit to a place carries these; an event's own row says null.
        return {
          ...shown,
          attendedAt: a.first_seen,
          stay_minutes: visit ? (stays.get(event.id) ?? null) : null,
          venue_id: visit ? venue_id : null,
          venue_type: visit ? (venue?.venue_type ?? null) : null,
          // A place is not a night you rate, so a visit says null.
          ratedAt: ratedAt.get(event.id) ?? null,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)

    return successResponse({
      events: rows,
      pagination: pagedPagination(query, visible, paged),
      lockedCount,
    })
  } catch (error) {
    logger.error("Get own attendance failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load your attendance")
  }
}

/**
 * `rows` (newest first) as the page `query` asks for, plus the one row past it
 * that tells `keysetPage` there is more: the same cut the SQL makes, for the
 * few nights a person without Plus can see.
 */
function afterThePosition(rows: Array<{ event_id: string; first_seen: Date }>, query: PagedQuery) {
  const rest =
    query.mode === "cursor"
      ? rows.filter(
          (r) =>
            r.first_seen < query.after.at || (r.first_seen.getTime() === query.after.at.getTime() && r.event_id < query.after.id)
        )
      : rows.slice(paginationSkip(query.page, query.limit))
  return rest.slice(0, query.limit + 1)
}
