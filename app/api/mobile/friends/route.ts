import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockCounterparties } from "@/lib/conversations"
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

    const [rows, blocked] = await Promise.all([
      db.friendships.findMany({
        where: {
          OR: [
            { user1_id: me, user2: { deletedAt: null } },
            { user2_id: me, user1: { deletedAt: null } },
          ],
        },
        select: { created_at: true, user1: { select: personSelect }, user2: { select: personSelect } },
        orderBy: { created_at: "desc" },
      }),
      /*
       * A block severs the friendship under the pair's lock, so this should
       * never filter anything. It is here so that if something ever does
       * leave a row behind, the list still never shows a blocked person.
       */
      blockCounterparties(me),
    ])
    const hidden = new Set(blocked)

    const friends = rows
      .map((r) => ({ other: r.user1.id === me ? r.user2 : r.user1, since: r.created_at }))
      .filter(({ other }) => !hidden.has(other.id))
      .map(({ other, since }) => ({ ...personCard(other), since }))

    return successResponse({ friends, count: friends.length })
  } catch (error) {
    logger.error("List friends error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friends")
  }
}
