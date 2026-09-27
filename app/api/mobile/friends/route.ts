import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { personCard, personSelect } from "@/lib/friends"
import { successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"

/**
 * GET /api/mobile/friends — the caller's friends, newest first, and how many.
 *
 * Real names and photos: both people said yes, and this is a friend surface,
 * not a room. A deleted account is dropped rather than shown as a husk.
 *
 * ponytail: unpaginated — a friends list is small; add a cursor when one
 * passes a few hundred.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const rows = await db.friendships.findMany({
      where: {
        OR: [
          { user1_id: me, user2: { deletedAt: null } },
          { user2_id: me, user1: { deletedAt: null } },
        ],
      },
      select: { created_at: true, user1: { select: personSelect }, user2: { select: personSelect } },
      orderBy: { created_at: "desc" },
    })

    const friends = rows.map((r) => ({
      ...personCard(r.user1.id === me ? r.user2 : r.user1),
      since: r.created_at,
    }))

    return successResponse({ friends, count: friends.length })
  } catch (error) {
    logger.error("List friends error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friends")
  }
}
