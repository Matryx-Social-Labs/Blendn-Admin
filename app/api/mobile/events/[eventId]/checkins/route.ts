import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { pseudonymsForEvent } from "@/lib/anonymous-names"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { normalizeLocationToCity } from "@/lib/location"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { parsePagination, paginationMeta, paginationSkip } from "@/lib/pagination"

/**
 * Who is in the room.
 *
 * Pseudonymous, like every other view of the room. This endpoint used to return
 * each attendee's real `User.name` and `image` to any authenticated caller,
 * while group chat, the participants list, the socket payloads and the dashboard
 * all carefully returned `chat_group_members.anonymous_name`. One endpoint undid
 * all of them, and it was readable straight out of the network tab — the same
 * defect `__tests__/chat-identity.test.ts` was written for on the dashboard side,
 * living on the mobile side the whole time.
 *
 * `userId` stays: a message request, a block and a report each need to name a
 * person, and the id alone discloses nothing.
 *
 * Age and city remain because they are what someone decides to say hello with,
 * and neither identifies. When the reveal flag lands, real name and photo become
 * available for attendees who have chosen it — never by default.
 */
interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Parse pagination params
    const searchParams = request.nextUrl.searchParams
    const { page, limit } = parsePagination(
      searchParams.get("page") ?? undefined,
      searchParams.get("limit") ?? undefined
    )

    // Check if event exists
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Get total count — same completeness filter as the list query below
    const profileCompletedFilter = {
      user: {
        profile: {
          onboarded: true,
          name: { not: null },
          photos: { isEmpty: false },
        },
      },
    }

    const totalCount = await db.event_check_ins.count({
      where: {
        event_id: eventId,
        status: "checked_in",
        ...profileCompletedFilter,
      },
    })

    // Fetch check-ins with user info — Fix #34: only include users with completed profiles
    const checkIns = await db.event_check_ins.findMany({
      where: {
        event_id: eventId,
        status: "checked_in",
        ...profileCompletedFilter,
      },
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: {
                age: true,
                location: true,
              },
            },
          },
        },
      },
      orderBy: { check_in_time: "desc" },
      skip: paginationSkip(page, limit),
      take: limit,
    })

    const pseudonyms = await pseudonymsForEvent(eventId)

    return successResponse({
      attendees: await Promise.all(
        checkIns.map(async (c) => ({
          // Kept: a message request, a block and a report all need to name a
          // person, and the id discloses nothing on its own.
          userId: c.user.id,
          name: pseudonyms.get(c.user.id) ?? "Attendee",
          // Deliberately absent: `image` and the real `name`. See the header.
          age: c.user.profile?.age,
          location: await normalizeLocationToCity(c.user.profile?.location),
          checkInTime: c.check_in_time,
        }))
      ),
      pagination: paginationMeta(page, limit, totalCount),
    })
  } catch (error) {
    logger.error("Get check-ins error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get attendees")
  }
}
