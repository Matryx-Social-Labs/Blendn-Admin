import jwt from "jsonwebtoken"
import { createHash } from "crypto"
import { db } from "@/lib/db"
import { Prisma } from "@prisma/client"

const JWT_SECRET = process.env.MOBILE_JWT_SECRET!

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
