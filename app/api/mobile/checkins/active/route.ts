import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Get all active check-ins for the user
    const checkIns = await db.event_check_ins.findMany({
      where: {
        user_id: authUser.userId,
        status: "checked_in",
      },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            slug: true,
            cover_image_url: true,
            start_time: true,
            end_time: true,
            venue_name: true,
            address: true,
            city: true,
            status: true,
          },
        },
      },
      orderBy: { check_in_time: "desc" },
    })

    /*
     * Whether *this* person is named in each of these rooms.
     *
     * The app shows a chip — "You're anonymous here" / "You're visible as
     * Sagar" — and nothing else could tell it which. The roster returns
     * pseudonyms by design, `/matches` never includes the viewer, and there is
     * no GET for per-event preferences. Without this the chip would have to
     * assume, and a chip that is wrong about your own anonymity is worse than
     * no chip: someone would keep quiet believing they were named, or speak
     * believing they were not.
     *
     * One query for every room they are in, keyed by the same
     * `(event_id, user_id)` uniqueness the preferences table enforces.
     */
    const prefs = await db.event_match_preferences.findMany({
      where: { user_id: authUser.userId, event_id: { in: checkIns.map((c) => c.event_id) } },
      select: { event_id: true, revealed: true },
    })
    const revealedIn = new Map(prefs.map((p) => [p.event_id, p.revealed]))

    return successResponse({
      checkIns: checkIns.map((c) => ({
        id: c.id,
        eventId: c.event_id,
        checkInTime: c.check_in_time,
        /*
         * Their own state, and only ever their own — this endpoint is scoped to
         * the authenticated user, so it cannot disclose anyone else's choice.
         * Absent row means anonymous, which is the server's default too.
         */
        revealed: revealedIn.get(c.event_id) ?? false,
        event: {
          id: c.event.id,
          title: c.event.title,
          slug: c.event.slug,
          coverImageUrl: c.event.cover_image_url,
          startTime: c.event.start_time,
          endTime: c.event.end_time,
          venueName: c.event.venue_name,
          address: c.event.address,
          city: c.event.city,
          status: c.event.status,
        },
      })),
    })
  } catch (error) {
    logger.error("Get active check-ins error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get active check-ins")
  }
}
