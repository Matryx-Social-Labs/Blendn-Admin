import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockedEitherWay } from "@/lib/conversations"
import { identityForRef, nonEventRoomCard } from "@/lib/identity"
import { refRoomBanRefusal } from "@/lib/room-ban"
import { sharedEvents } from "@/lib/shared-events"
import { SYSTEM_USER_ID } from "@/lib/event-kind"
import { parseListQuery, type ListPagination } from "@/lib/pagination"
import { errorResponse, notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"

/** The person page shows five; See all pages by twenty. */
const DEFAULT_PAGE = 20

/**
 * GET /api/mobile/users/:ref/shared-events — "You've both been to" (SCRUM-1042): past events you and this person were
 * both checked in to, where they were not a pseudonym to you (`lib/shared-events.ts`), newest first.
 *
 * `ref` is a room handle or a raw id, gated exactly as `GET /users/:ref` gates the name: a handle answers in its own
 * room's terms. A ref that does not name them to you answers an empty list, never an error, so the list cannot tell you
 * anything the profile beside it does not: a non-empty list for a pseudonym's handle would name the pseudonym.
 *
 * `?limit=` (default 20, at most 100) and `?cursor=` (the last page's `nextCursor`).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Authentication required")
    const viewerId = authUser.userId

    const query = parseListQuery(request.nextUrl.searchParams, DEFAULT_PAGE)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit, after } = query
    const empty = () =>
      successResponse({ events: [], pagination: { limit, hasMore: false, nextCursor: null, totalCount: 0 } satisfies ListPagination })

    const { userId: ref } = await params
    const banned = await refRoomBanRefusal(ref, viewerId)
    if (banned) return banned
    // A crew's, Blend's or board post's handle is a room card, never an identity with a history.
    if (await nonEventRoomCard(viewerId, ref)) return empty()
    const { userId, identified, askedOnly } = await identityForRef(viewerId, ref)
    if (userId === SYSTEM_USER_ID) return notFoundResponse("User not found")
    // As the profile answers a block: nobody here, without saying why.
    if (userId !== viewerId && (await blockedEitherWay(viewerId, userId))) return notFoundResponse("User not found")
    // Not named to you, or named only by their own pending request (no bio until you accept, A-32): no history either.
    if (!identified || askedOnly || userId === viewerId) return empty()

    const page = await sharedEvents(viewerId, userId, { limit, after })
    return successResponse({
      events: page.events,
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount } satisfies ListPagination,
    })
  } catch (error) {
    logger.error("Shared events error", { error })
    return serverErrorResponse("Failed to load shared events")
  }
}
