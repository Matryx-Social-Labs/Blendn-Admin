import { NextRequest } from "next/server"

import { notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { anonymousCard, latestRoom, personCardBody, publicUserSelect, roomPersonFacts } from "@/lib/public-profile"

export const dynamic = "force-dynamic"

/**
 * GET /api/mobile/me/preview — "See as others do" (Me, board me-settings 01-A; SCRUM-1076).
 *
 * Your own card exactly as somebody in an event's room reads it from `GET /users/:handle`, in both states:
 *
 * - `anonymous`: before you reveal — your pseudonym, and the age band and new / regular chip that room shows
 *   (`roomPersonFacts`), and nothing else;
 * - `named`: once they may see who you are (you revealed, or a friend you let see you) — first name, photos and the
 *   rest, as that viewer gets them.
 *
 * Built by the same functions as that route (`lib/public-profile.ts`), so the preview cannot show a field the room
 * would withhold, or miss one it would send. What depends on the viewer (tonight's answer, a wave, the connection,
 * the friend offer, shared interests) is left out: there is no viewer.
 *
 * `pseudonym` is the one you carry in the event room you joined last, null before your first room (the anonymous card
 * then reads "Attendee", as the room's own fallback does). It is yours, so naming it here tells you nothing new.
 * Scoped to the caller by construction: there is no id in the path.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const [user, { pseudonym, eventId }] = await Promise.all([
      db.user.findUnique({ where: { id: me, deletedAt: null }, select: publicUserSelect }),
      latestRoom(me),
    ])
    if (!user) return notFoundResponse("User not found")

    // The band and chip that room shows beside your pseudonym; your own card, so no viewer (`roomPersonFacts`).
    const [facts, named] = await Promise.all([
      roomPersonFacts(null, eventId, [me]),
      personCardBody(user, { id: me, identified: true, askedOnly: false, firstNameOnly: true, isOwnProfile: false }),
    ])
    const anonymous = anonymousCard(me, { name: pseudonym ?? "Attendee", pseudonym: pseudonym !== null }, facts.get(me)!)
    return successResponse({ pseudonym, anonymous, named })
  } catch (error) {
    logger.error("Profile preview error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the preview")
  }
}
