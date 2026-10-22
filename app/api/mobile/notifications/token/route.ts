import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { db } from "@/lib/db"
import { registerPushToken } from "@/lib/push-token"
import {
  successResponse,
  errorResponse,
  ErrorCode,
  unauthorizedResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson } from "@/lib/api-input"

const pushTokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
  // zod 4 replaced the `errorMap` param with `error`.
  platform: z.enum(["ios", "android"], {
    error: "Platform must be 'ios' or 'android'",
  }),
})

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("write", "push-token", user.userId))
    if (limited) return limited

    const body = await readJson(request)

    // Validate request body
    const validation = pushTokenSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { token, platform } = validation.data

    // One device, one account: a token moves to whoever registers it (lib/push-token.ts).
    const registered = await registerPushToken(user.userId, token, platform)
    if (!registered.ok) {
      return registered.reason === "not_a_token"
        ? errorResponse("Not a valid push token", 400, ErrorCode.VALIDATION_FAILED)
        : errorResponse("Too many devices switched accounts. Try again later.", 429, ErrorCode.RATE_LIMITED)
    }

    // Keep only this account's three most recent tokens per platform (multiple devices). One statement,
    // and only this account's rows: a row another account just took over is not ours to prune.
    await db.$executeRaw`
      DELETE FROM push_tokens
       WHERE user_id = ${user.userId} AND platform = ${platform}
         AND id NOT IN (
           SELECT id FROM push_tokens
            WHERE user_id = ${user.userId} AND platform = ${platform}
            ORDER BY updated_at DESC, id DESC
            LIMIT 3)`

    return successResponse({
      message: "Push token registered successfully",
    })
  } catch (error) {
    logger.error("Register push token error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to register push token")
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("write", "push-token", user.userId))
    if (limited) return limited

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
    logger.error("Remove push token error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to remove push token")
  }
}
