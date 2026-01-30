import jwt from "jsonwebtoken"
import { createHash } from "crypto"
import { db } from "@/lib/db"
import { Prisma } from "@prisma/client"

const JWT_SECRET = process.env.MOBILE_JWT_SECRET!
const GOOGLE_CLIENT_IDS = [
  process.env.GOOGLE_WEB_CLIENT_ID,
  process.env.GOOGLE_IOS_CLIENT_ID,
  process.env.GOOGLE_ANDROID_CLIENT_ID,
].filter(Boolean) as string[]

if (!JWT_SECRET) {
  throw new Error("MOBILE_JWT_SECRET environment variable is not set")
}

const ACCESS_TOKEN_EXPIRY = "15m"
const REFRESH_TOKEN_EXPIRY = "30d"
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000 // 30 days in ms

export interface TokenPayload {
  userId: string
  email: string
  type: "access" | "refresh"
}

export interface DecodedToken extends TokenPayload {
  iat: number
  exp: number
}

/**
 * Sign an access token (15 min expiry)
 */
export function signAccessToken(userId: string, email: string): string {
  const payload: TokenPayload = {
    userId,
    email,
    type: "access",
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY })
}

/**
 * Sign a refresh token (30 day expiry)
 */
export function signRefreshToken(userId: string, email: string): string {
  const payload: TokenPayload = {
    userId,
    email,
    type: "refresh",
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY })
}

/**
 * Verify and decode an access token
 */
export function verifyAccessToken(token: string): DecodedToken | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as DecodedToken
    if (decoded.type !== "access") {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

/**
 * Hash a token for secure storage
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Store a hashed refresh token in the database
 */
export async function storeRefreshToken(
  userId: string,
  token: string,
  deviceInfo?: Prisma.InputJsonValue
): Promise<void> {
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS)

  await db.mobile_refresh_tokens.create({
    data: {
      user_id: userId,
      token_hash: tokenHash,
      device_info: deviceInfo,
      expires_at: expiresAt,
    },
  })
}

/**
 * Verify a refresh token against the database
 * Returns the decoded token if valid, null otherwise
 */
export async function verifyRefreshToken(
  token: string
): Promise<DecodedToken | null> {
  try {
    // First verify the JWT signature and expiry
    const decoded = jwt.verify(token, JWT_SECRET) as DecodedToken
    if (decoded.type !== "refresh") {
      return null
    }

    // Check if token exists in DB and is not revoked
    const tokenHash = hashToken(token)
    const storedToken = await db.mobile_refresh_tokens.findUnique({
      where: { token_hash: tokenHash },
    })

    if (!storedToken) {
      return null
    }

    // Check if token is revoked
    if (storedToken.revoked_at) {
      return null
    }

    // Check if token is expired in DB
    if (storedToken.expires_at < new Date()) {
      return null
    }

    return decoded
  } catch {
    return null
  }
}

/**
 * Revoke all refresh tokens for a user
 */
export async function revokeUserRefreshTokens(userId: string): Promise<void> {
  await db.mobile_refresh_tokens.updateMany({
    where: {
      user_id: userId,
      revoked_at: null,
    },
    data: {
      revoked_at: new Date(),
    },
  })
}

/**
 * Revoke a specific refresh token
 */
export async function revokeRefreshToken(token: string): Promise<void> {
  const tokenHash = hashToken(token)
  await db.mobile_refresh_tokens.updateMany({
    where: {
      token_hash: tokenHash,
      revoked_at: null,
    },
    data: {
      revoked_at: new Date(),
    },
  })
}

/**
 * Extract bearer token from Authorization header
 */
export function extractBearerToken(
  authHeader: string | null
): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null
  }
  return authHeader.slice(7)
}

/**
 * Get authenticated user from request
 * Returns null if not authenticated
 */
export async function getAuthenticatedUser(
  request: Request
): Promise<{ userId: string; email: string } | null> {
  const authHeader = request.headers.get("Authorization")
  const token = extractBearerToken(authHeader)

  if (!token) {
    return null
  }

  const decoded = verifyAccessToken(token)
  if (!decoded) {
    return null
  }

  return {
    userId: decoded.userId,
    email: decoded.email,
  }
}

/**
 * Clean up expired refresh tokens (can be called periodically)
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const result = await db.mobile_refresh_tokens.deleteMany({
    where: {
      OR: [
        { expires_at: { lt: new Date() } },
        { revoked_at: { not: null } },
      ],
    },
  })
  return result.count
}

/**
 * Google OAuth token payload structure
 */
export interface GoogleTokenPayload {
  sub: string // Google user ID
  email: string
  email_verified: boolean
  name?: string
  picture?: string
  given_name?: string
  family_name?: string
  aud: string
  iss: string
  exp: number
  iat: number
}

/**
 * Verify a Google ID token using Google's tokeninfo endpoint
 * Returns the decoded payload if valid, null otherwise
 */
export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleTokenPayload | null> {
  try {
    // Verify the token with Google's tokeninfo endpoint
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    )

    if (!response.ok) {
      console.error("Google token verification failed:", response.status)
      return null
    }

    const payload = (await response.json()) as GoogleTokenPayload

    // Verify the audience matches one of our client IDs
    if (GOOGLE_CLIENT_IDS.length > 0 && !GOOGLE_CLIENT_IDS.includes(payload.aud)) {
      console.error("Google token audience mismatch:", payload.aud)
      return null
    }

    // Verify the issuer
    if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) {
      console.error("Google token issuer mismatch:", payload.iss)
      return null
    }

    // Verify the token is not expired
    if (payload.exp * 1000 < Date.now()) {
      console.error("Google token expired")
      return null
    }

    // Verify email is verified
    if (!payload.email_verified) {
      console.error("Google email not verified")
      return null
    }

    return payload
  } catch (error) {
    console.error("Error verifying Google ID token:", error)
    return null
  }
}

/**
 * Find or create a user from Google OAuth
 * Returns the user ID and whether this is a new user
 */
export async function findOrCreateGoogleUser(
  googlePayload: GoogleTokenPayload
): Promise<{ userId: string; email: string; isNewUser: boolean }> {
  // First, check if we have an existing OAuth account for this Google ID
  const existingOAuth = await db.user_oauth_accounts.findUnique({
    where: {
      provider_provider_id: {
        provider: "google",
        provider_id: googlePayload.sub,
      },
    },
    include: { user: true },
  })

  if (existingOAuth) {
    return {
      userId: existingOAuth.user_id,
      email: existingOAuth.user.email,
      isNewUser: false,
    }
  }

  // Check if a user exists with this email
  const existingUser = await db.user.findUnique({
    where: { email: googlePayload.email },
  })

  if (existingUser) {
    // Link the Google account to the existing user
    await db.user_oauth_accounts.create({
      data: {
        user_id: existingUser.id,
        provider: "google",
        provider_id: googlePayload.sub,
        email: googlePayload.email,
      },
    })

    return {
      userId: existingUser.id,
      email: existingUser.email,
      isNewUser: false,
    }
  }

  // Create a new user with the Google account
  const newUser = await db.user.create({
    data: {
      email: googlePayload.email,
      name: googlePayload.name || googlePayload.given_name || null,
      image: googlePayload.picture || null,
      emailVerified: new Date(), // Google email is verified
      profile: {
        create: {
          name: googlePayload.name || googlePayload.given_name || null,
          onboarded: false,
        },
      },
      oauth_accounts: {
        create: {
          provider: "google",
          provider_id: googlePayload.sub,
          email: googlePayload.email,
        },
      },
    },
  })

  return {
    userId: newUser.id,
    email: newUser.email,
    isNewUser: true,
  }
}
