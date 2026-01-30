import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

const pushTokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
  platform: z.enum(["ios", "android"], {
    errorMap: () => ({ message: "Platform must be 'ios' or 'android'" }),
  }),
})

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const body = await request.json()

    // Validate request body
    const validation = pushTokenSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { token, platform } = validation.data

    // Upsert the push token
    // If the same user+token combination exists, update it
    // If not, create a new one
    const now = new Date()

    await db.push_tokens.upsert({
      where: {
        user_id_token: {
          user_id: user.userId,
          token: token,
        },
      },
      update: {
        platform,
        updated_at: now,
      },
      create: {
        user_id: user.userId,
        token,
        platform,
        created_at: now,
        updated_at: now,
      },
    })

    // Clean up old tokens for this user on this platform
    // Keep only the most recent 3 tokens per platform to handle multiple devices
    const userTokens = await db.push_tokens.findMany({
      where: {
        user_id: user.userId,
        platform,
      },
      orderBy: {
        updated_at: "desc",
      },
    })

    if (userTokens.length > 3) {
      const tokensToDelete = userTokens.slice(3).map((t) => t.id)
      await db.push_tokens.deleteMany({
        where: {
          id: { in: tokensToDelete },
        },
      })
    }

    return successResponse({
      message: "Push token registered successfully",
    })
  } catch (error) {
    console.error("Register push token error:", error)
    return serverErrorResponse("Failed to register push token")
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const { searchParams } = new URL(request.url)
    const token = searchParams.get("token")

    if (!token) {
      return errorResponse("Token is required", 400)
    }

    // Delete the specific token
    await db.push_tokens.deleteMany({
      where: {
        user_id: user.userId,
        token,
      },
    })

    return successResponse({
      message: "Push token removed successfully",
    })
  } catch (error) {
    console.error("Remove push token error:", error)
    return serverErrorResponse("Failed to remove push token")
  }
}
