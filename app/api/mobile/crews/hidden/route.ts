import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { hiddenCrews } from "@/lib/crews/hides"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { parsePagination } from "@/lib/pagination"

/** GET /api/mobile/crews/hidden?page&limit — Settings → Blocked: the crews you hid, newest first. */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const q = request.nextUrl.searchParams
    return successResponse(await hiddenCrews(authUser.userId, parsePagination(q.get("page") ?? undefined, q.get("limit") ?? undefined)))
  } catch (error) {
    logger.error("Hidden crews error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load hidden crews")
  }
}
