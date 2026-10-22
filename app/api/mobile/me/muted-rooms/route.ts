import { NextRequest } from "next/server"

import { ErrorCode, errorResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  decodeMutedCursor,
  MUTED_ROOMS_DEFAULT_LIMIT,
  MUTED_ROOMS_MAX_LIMIT,
  mutedRoomPage,
} from "@/lib/muted-rooms"
import { boundedInt } from "@/lib/pagination"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

/**
 * GET /api/mobile/me/muted-rooms?limit=&cursor= — the rooms you silenced
 * (Settings › Notifications › Muted rooms), newest mute first.
 *
 * Each row is a `GET /chat/groups` row (`kind` is `event`, `crew` or `blend`,
 * `mute` says until when), built by the same code. Only rooms that list would
 * show: a live room, through its owner's door. `limit` 1–100 (default 50); a
 * `cursor` that an earlier answer did not give is a 400.
 * See `lib/muted-rooms.ts`.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "me-muted-rooms", authUser.userId))
    if (limited) return limited

    const params = request.nextUrl.searchParams
    const limit = boundedInt(params.get("limit"), MUTED_ROOMS_DEFAULT_LIMIT, 1, MUTED_ROOMS_MAX_LIMIT)
    const raw = params.get("cursor")
    const after = raw ? decodeMutedCursor(raw) : null
    if (raw && !after) return errorResponse("Invalid cursor", 400, ErrorCode.VALIDATION_FAILED)

    const { rooms, nextCursor } = await mutedRoomPage(authUser.userId, limit, after)
    const res = await successResponse({ rooms, nextCursor, pagination: { limit, hasMore: nextCursor !== null } })
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Get muted rooms failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the muted rooms")
  }
}
