import { NextRequest } from "next/server"
import { z } from "zod"
import {
  verifyGoogleIdToken,
  findOrCreateGoogleUser,
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
} from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

const googleAuthSchema = z.object({
  idToken: z.string().min(1, "ID token is required"),
  deviceInfo: z
    .object({
      platform: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
    })
    .optional(),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Validate request body
    const validation = googleAuthSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { idToken, deviceInfo } = validation.data

    // Verify the Google ID token
    const googlePayload = await verifyGoogleIdToken(idToken)
    if (!googlePayload) {
      return errorResponse("Invalid or expired Google token", 401)
    }

    // Find or create user from Google OAuth
    const { userId, email, isNewUser } = await findOrCreateGoogleUser(googlePayload)

    // Generate tokens
    const accessToken = signAccessToken(userId, email)
    const refreshToken = signRefreshToken(userId, email)

    // Store refresh token
    await storeRefreshToken(userId, refreshToken, deviceInfo)

    // Get user with profile
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        createdAt: true,
        profile: {
          select: {
            phone: true,
            name: true,
            age: true,
            location: true,
            interests: true,
            onboarded: true,
          },
        },
      },
    })

    return successResponse(
      {
        user,
        accessToken,
        refreshToken,
        isNewUser,
      },
      isNewUser ? 201 : 200
    )
  } catch (error) {
    console.error("Google auth error:", error)
    return serverErrorResponse("Failed to authenticate with Google")
  }
}
