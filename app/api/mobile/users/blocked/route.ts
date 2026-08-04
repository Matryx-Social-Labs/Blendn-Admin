import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"

// GET /api/mobile/users/blocked — List users blocked by the current user
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const blocks = await db.blocked_users.findMany({
      where: { blocker_id: authUser.userId },
      orderBy: { created_at: "desc" },
      include: {
        blocked: {
          select: { id: true, name: true, image: true },
        },
      },
    })

    const users = blocks.map((b) => ({
      blocked_id: b.blocked_id,
      blocked_user_name: b.blocked.name,
      blocked_user_photo: b.blocked.image,
      reason: null,
      blocked_at: b.created_at.toISOString(),
    }))

    return successResponse({ users })
  } catch (error) {
    logger.error("Get blocked users error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to fetch blocked users")
  }
}
