import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ userId: string }>
}

// POST /api/mobile/users/[userId]/block — Block a user
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const { userId: targetId } = await params

    if (targetId === authUser.userId) {
      return errorResponse("Cannot block yourself", 400)
    }

    // Verify target user exists
    const target = await db.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    })

    if (!target) {
      return notFoundResponse("User not found")
    }

    // Upsert block record (idempotent)
    await db.blocked_users.upsert({
      where: {
        blocker_id_blocked_id: {
          blocker_id: authUser.userId,
          blocked_id: targetId,
        },
      },
      create: {
        blocker_id: authUser.userId,
        blocked_id: targetId,
      },
      update: {},
    })

    // Also cancel any pending message request from the blocked user
    await db.message_requests.updateMany({
      where: {
        sender_id: targetId,
        recipient_id: authUser.userId,
        status: "pending",
      },
      data: { status: "blocked" },
    })

    return successResponse({ blocked: true })
  } catch (error) {
    console.error("Block user error:", error)
    return serverErrorResponse("Failed to block user")
  }
}

// DELETE /api/mobile/users/[userId]/block — Unblock a user
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const { userId: targetId } = await params

    await db.blocked_users.deleteMany({
      where: {
        blocker_id: authUser.userId,
        blocked_id: targetId,
      },
    })

    return successResponse({ blocked: false })
  } catch (error) {
    console.error("Unblock user error:", error)
    return serverErrorResponse("Failed to unblock user")
  }
}
