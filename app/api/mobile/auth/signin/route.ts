import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"
import { db } from "@/lib/db"
import {
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
} from "@/lib/mobile-auth"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { signinSchema } from "@/lib/validations/auth"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Validate input
    const parsed = signinSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { email, password, deviceInfo } = parsed.data

    // Find user
    const user = await db.user.findUnique({
      where: { email },
      include: {
        profile: true,
      },
    })

    if (!user || !user.password) {
      return unauthorizedResponse("Invalid email or password")
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password)
    if (!isValidPassword) {
      return unauthorizedResponse("Invalid email or password")
    }

    // Generate tokens
    const accessToken = signAccessToken(user.id, user.email)
    const refreshToken = signRefreshToken(user.id, user.email)

    // Store refresh token
    await storeRefreshToken(user.id, refreshToken, deviceInfo)

    return successResponse({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        profile: user.profile,
      },
      accessToken,
      refreshToken,
    })
  } catch (error) {
    console.error("Signin error:", error)
    return serverErrorResponse("Failed to sign in")
  }
}
