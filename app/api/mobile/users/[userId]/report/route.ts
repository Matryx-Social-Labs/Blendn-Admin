import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ userId: string }>
}

const reportUserSchema = z.object({
  reason: z.string().min(1, "Reason is required"),
  description: z.string().optional(),
})

// POST /api/mobile/users/[userId]/report — Report a user
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const { userId: reportedId } = await params

    if (reportedId === authUser.userId) {
      return errorResponse("Cannot report yourself", 400)
    }

    const body = await request.json()
    const validation = reportUserSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const target = await db.user.findUnique({
      where: { id: reportedId },
      select: { id: true },
    })
    if (!target) {
      return notFoundResponse("User not found")
    }

    await db.user_reports.create({
      data: {
        reporter_id: authUser.userId,
        reported_id: reportedId,
        reason: validation.data.reason,
        description: validation.data.description,
      },
    })

    return successResponse({ reported: true }, 201)
  } catch (error) {
    logger.error("Report user error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to submit report")
  }
}
