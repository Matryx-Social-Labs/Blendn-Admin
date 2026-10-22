import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockCounterparties } from "@/lib/conversations"
import { personCard, personSelect } from "@/lib/friends"
import { errorResponse, successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"
import {
  createdBefore,
  keysetPage,
  LIST_PAGE,
  NEWEST_FIRST,
  parseListQuery,
  type ListPagination,
} from "@/lib/pagination"

/**
 * GET /api/mobile/friends — the caller's friends, newest first, a page at a
 * time, and how many in all.
 *
 * Real names and photos: both people said yes, and this is a friend surface,
 * not a room. A deleted account is dropped rather than shown as a husk.
 *
 * `?limit=` (default 100, at most 100) and `?cursor=` (the last page's
 * `pagination.nextCursor`). `count` is the whole list, not the page, and
 * `pagination.totalCount` is the same number: an installed client that reads
 * `friends` and `count` shows the first hundred and the true total.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const query = parseListQuery(request.nextUrl.searchParams, LIST_PAGE.PEOPLE)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit, after } = query

    /*
     * A block severs the friendship under the pair's lock, so this should
     * never filter anything. It is here so that if something ever does
     * leave a row behind, the list still never shows a blocked person — and
     * in the query, not after it, so a page is `limit` friends and the count
     * is the list.
     */
    const blocked = await blockCounterparties(me)
    const mine = {
      OR: [
        { user1_id: me, user2_id: { notIn: blocked }, user2: { deletedAt: null } },
        { user2_id: me, user1_id: { notIn: blocked }, user1: { deletedAt: null } },
      ],
    }

    const [totalCount, rows] = await Promise.all([
      db.friendships.count({ where: mine }),
      db.friendships.findMany({
        where: after ? { AND: [mine, createdBefore(after)] } : mine,
        select: { id: true, created_at: true, user1: { select: personSelect }, user2: { select: personSelect } },
        orderBy: NEWEST_FIRST,
        take: limit + 1,
      }),
    ])
    const page = keysetPage(rows, limit, (r) => ({ at: r.created_at, id: r.id }))

    const friends = page.items.map((r) => ({
      ...personCard(r.user1.id === me ? r.user2 : r.user1),
      since: r.created_at,
    }))

    return successResponse({
      friends,
      count: totalCount,
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount } satisfies ListPagination,
    })
  } catch (error) {
    logger.error("List friends error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friends")
  }
}
