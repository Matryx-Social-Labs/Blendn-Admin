import { logger } from "./logger"
import jwt from "jsonwebtoken"
import { randomUUID } from "crypto"
import bcrypt from "bcryptjs"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { db } from "./db"
import { Prisma } from "@prisma/client"

function getJwtSecret(): string {
  const secret = process.env.MOBILE_JWT_SECRET
  if (!secret) {
    throw new Error("MOBILE_JWT_SECRET environment variable is not set")
  }
  return secret
}
const GOOGLE_CLIENT_IDS = [
  process.env.GOOGLE_WEB_CLIENT_ID,
  process.env.GOOGLE_IOS_CLIENT_ID,
  process.env.GOOGLE_ANDROID_CLIENT_ID,
].filter(Boolean) as string[]

// Apple identity tokens issued to the native app have this as the audience
const APPLE_AUDIENCE = process.env.APPLE_BUNDLE_ID || "com.matryxsociallabs.blendn"
const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"))

const ACCESS_TOKEN_EXPIRY = "15m"
const REFRESH_TOKEN_EXPIRY = "30d"
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000 // 30 days in ms

/**
 * How long after rotation a replayed refresh token is treated as a client
 * retry rather than as theft.
 *
 * The refresh route revokes the old token *before* the client has stored the
 * new one, so a lost response (app backgrounded or killed mid-refresh, flaky
 * network) leaves the client holding a token the server already revoked.
 * Replaying it is the normal recovery path, not an attack — and because
 * `mobile_refresh_tokens` has no family/chain column, the theft response can
 * only revoke *every* session for the user. Without this window an interrupted
 * refresh on one phone signs the user out on all their devices.
 *
 * A replay long after rotation is still treated as theft.
 */
const REFRESH_REUSE_GRACE_MS = 60 * 1000 // 60 seconds

export interface TokenPayload {
  userId: string
  email: string
  type: "access" | "refresh"
  jti?: string
}

export interface DecodedToken extends TokenPayload {
  iat: number
  exp: number
}

const BCRYPT_ROUNDS = 12

/**
 * Sign an access token (15 min expiry)
 */
export function signAccessToken(userId: string, email: string): string {
  const payload: TokenPayload = {
    userId,
    email,
    type: "access",
  }
  return jwt.sign(payload, getJwtSecret(), { expiresIn: ACCESS_TOKEN_EXPIRY })
}

/**
 * Sign a refresh token (30 day expiry) with a jti for DB lookup
 */
export function signRefreshToken(userId: string, email: string): string {
  const tokenId = randomUUID()
  const payload: TokenPayload = {
    userId,
    email,
    type: "refresh",
    jti: tokenId,
  }
  return jwt.sign(payload, getJwtSecret(), { expiresIn: REFRESH_TOKEN_EXPIRY })
}

/**
 * Verify and decode an access token
 */
export function verifyAccessToken(token: string): DecodedToken | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as DecodedToken
    if (decoded.type !== "access") {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

/**
 * Store a bcrypt-hashed refresh token in the database
 * Uses the JWT's jti claim as the record ID for lookups
 */
export async function storeRefreshToken(
  userId: string,
  token: string,
  deviceInfo?: Prisma.InputJsonValue
): Promise<void> {
  // Decode without verification to extract jti (we just signed it)
  const decoded = jwt.decode(token) as DecodedToken | null
  if (!decoded?.jti) {
    // signRefreshToken always sets a jti; if it is missing the token is not one
    // of ours and there would be nothing to key rotation or revocation on.
    throw new Error("Cannot store a refresh token without a jti")
  }

  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS)

  await db.mobile_refresh_tokens.create({
    data: {
      id: decoded.jti,
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
    const decoded = jwt.verify(token, getJwtSecret()) as DecodedToken
    if (decoded.type !== "refresh" || !decoded.jti) {
      return null
    }

    // Look up the token record by jti (stored as the record id)
    const storedToken = await db.mobile_refresh_tokens.findUnique({
      where: { id: decoded.jti },
    })

    if (!storedToken) {
      return null
    }

    // A revoked token presented again was already rotated out and is being
    // replayed — usually the classic signal that it was stolen. Kill the whole
    // token family so both the attacker and the legitimate holder are forced to
    // re-authenticate.
    //
    // Exception: a replay within REFRESH_REUSE_GRACE_MS of rotation is almost
    // certainly the client retrying after it never received the new token.
    // Reject the request, but don't sign the user out everywhere over it.
    if (storedToken.revoked_at) {
      const sinceRevokedMs = Date.now() - storedToken.revoked_at.getTime()

      if (sinceRevokedMs <= REFRESH_REUSE_GRACE_MS) {
        logger.info("Refresh token replayed just after rotation, treating as client retry", {
          userId: storedToken.user_id,
          sinceRevokedMs,
        })
        return null
      }

      logger.error("Refresh token reuse detected, revoking all refresh tokens", {
        userId: storedToken.user_id,
        sinceRevokedMs,
      })
      await revokeUserRefreshTokens(storedToken.user_id)
      return null
    }

    // Check if token is expired in DB
    if (storedToken.expires_at < new Date()) {
      return null
    }

    // Verify the token against the stored bcrypt hash
    const isValid = await bcrypt.compare(token, storedToken.token_hash)
    if (!isValid) {
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
  try {
    const decoded = jwt.decode(token) as DecodedToken | null
    if (!decoded?.jti) return

    await db.mobile_refresh_tokens.updateMany({
      where: {
        id: decoded.jti,
        revoked_at: null,
      },
      data: {
        revoked_at: new Date(),
      },
    })
  } catch {
    // Token may be malformed, nothing to revoke
  }
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
      logger.warn("Google token verification failed", { status: response.status })
      return null
    }

    const payload = (await response.json()) as GoogleTokenPayload

    /*
     * Fail closed when no client id is configured.
     *
     * This used to read `GOOGLE_CLIENT_IDS.length > 0 && !includes(aud)`, so
     * with the three optional env vars unset the audience was not checked at
     * all -- and `aud` is the only claim that ties a Google token to *us*.
     * Everything else (`iss`, `exp`, signature) is satisfied by any token
     * Google ever issued to anyone. Someone could stand up an unrelated app
     * with Google Sign-In, collect its users' id tokens legitimately, replay
     * one here, and be handed Blendn tokens for that person's account.
     *
     * The Apple path never had this hole: it pins `APPLE_AUDIENCE` with a
     * literal fallback rather than falling back to no check.
     */
    if (GOOGLE_CLIENT_IDS.length === 0) {
      logger.error(
        "Google sign-in attempted with no GOOGLE_*_CLIENT_ID configured; refusing to skip the audience check"
      )
      return null
    }
    if (!GOOGLE_CLIENT_IDS.includes(payload.aud)) {
      logger.warn("Google token audience mismatch")
      return null
    }

    // Verify the issuer
    if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) {
      logger.warn("Google token issuer mismatch")
      return null
    }

    // Verify the token is not expired
    if (payload.exp * 1000 < Date.now()) {
      logger.warn("Google token expired")
      return null
    }

    /*
     * Compare explicitly, because this payload comes from Google's `tokeninfo`
     * endpoint rather than a locally-decoded JWT, and that endpoint returns
     * every claim as a **string**: `"email_verified": "false"`. A truthiness
     * test therefore accepted an unverified address, since `"false"` is a
     * non-empty string. The `exp` check above survives the same coercion only
     * by luck -- `"1433981953" * 1000` happens to work.
     *
     * `AppleTokenPayload` already types this field `boolean | string`, so the
     * string form was known here; it just was not applied to the path where it
     * decides whether someone owns an address.
     */
    if (payload.email_verified !== true && String(payload.email_verified) !== "true") {
      logger.warn("Google email not verified")
      return null
    }

    return payload
  } catch (error) {
    logger.error("Error verifying Google ID token", { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * Find or create a user from Google OAuth
 * Returns the user ID and whether this is a new user
 */
/**
 * Attach a provider identity to an existing account, safely.
 *
 * ## The hole this closes
 *
 * `POST /auth/signup` creates a `User` from any email with **no proof of
 * ownership** -- no verification mail is sent and `emailVerified` is left null.
 * Both OAuth paths then resolved an unknown provider `sub` by looking the email
 * up and silently linking to whatever row they found. So:
 *
 *   1. Attacker signs up as `victim@gmail.com` with a password they choose.
 *      Nothing is sent to the victim; nothing tells them an account exists.
 *   2. Victim later taps "Continue with Google". Their token is genuine, the
 *      `sub` is unknown, the email matches -- and they are logged into the
 *      **attacker's row**. They onboard, check in, send DMs.
 *   3. The attacker signs in with the password they set in step 1 and has the
 *      victim's account, conversations and check-in history.
 *
 * ## Why the password is cleared
 *
 * Google and Apple have *proved* control of the address. An unverified password
 * signup has proved nothing. So when the two disagree the OAuth identity wins:
 * we mark the address verified and drop the password credential, which evicts
 * a squatter and costs a legitimate user -- someone who really did sign up with
 * a password and never verified -- one password reset.
 *
 * An account whose email is already verified was reached by proving ownership,
 * so its password is left alone and the link is ordinary.
 */
async function linkVerifiedOAuthIdentity(
  existingUser: { id: string; emailVerified: Date | null; password: string | null },
  provider: "google" | "apple",
  providerId: string,
  email: string
): Promise<void> {
  const unproven = existingUser.emailVerified === null

  await db.$transaction([
    db.user_oauth_accounts.create({
      data: {
        user_id: existingUser.id,
        provider,
        provider_id: providerId,
        email,
      },
    }),
    db.user.update({
      where: { id: existingUser.id },
      data: unproven
        ? { emailVerified: new Date(), password: null }
        : { emailVerified: existingUser.emailVerified },
    }),
  ])

  if (unproven && existingUser.password) {
    // Worth knowing about: either a squatter was just evicted, or someone will
    // wonder why their password stopped working.
    logger.warn("Cleared an unverified password credential on OAuth link", {
      userId: existingUser.id,
      provider,
    })
  }
}

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
    await linkVerifiedOAuthIdentity(existingUser, "google", googlePayload.sub, googlePayload.email)

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

export interface AppleTokenPayload {
  sub: string // Apple user ID
  email?: string
  email_verified?: boolean | string
  aud: string
  iss: string
  exp: number
  iat: number
}

/**
 * Verify an Apple Sign in identity token (JWT signed by Apple, verified
 * against Apple's published JWKS).
 */
export async function verifyAppleIdToken(
  identityToken: string
): Promise<AppleTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(identityToken, appleJwks, {
      issuer: "https://appleid.apple.com",
      audience: APPLE_AUDIENCE,
    })

    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      logger.warn("Apple token expired")
      return null
    }

    return payload as unknown as AppleTokenPayload
  } catch (error) {
    logger.error("Error verifying Apple identity token", { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * Find or create a user from Sign in with Apple.
 * `fullName` is only ever sent by Apple on the user's first authorization,
 * so it must be passed through from the client on that first call.
 */
export async function findOrCreateAppleUser(
  applePayload: AppleTokenPayload,
  fullName?: { givenName?: string | null; familyName?: string | null }
): Promise<{ userId: string; email: string; isNewUser: boolean }> {
  const existingOAuth = await db.user_oauth_accounts.findUnique({
    where: {
      provider_provider_id: {
        provider: "apple",
        provider_id: applePayload.sub,
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

  const displayName = [fullName?.givenName, fullName?.familyName].filter(Boolean).join(" ") || null

  // Apple may omit email on tokens after the first authorization; in that
  // case Apple guarantees `sub` is stable so the OAuth-account lookup above
  // is the source of truth. A missing email at this point only happens on
  // a genuinely new user, which Apple does not allow without an email scope.
  const email = applePayload.email

  if (email) {
    const existingUser = await db.user.findUnique({ where: { email } })

    if (existingUser) {
      await linkVerifiedOAuthIdentity(existingUser, "apple", applePayload.sub, email)

      return {
        userId: existingUser.id,
        email: existingUser.email,
        isNewUser: false,
      }
    }
  }

  if (!email) {
    throw new Error("Apple sign in did not provide an email for a new user")
  }

  const newUser = await db.user.create({
    data: {
      email,
      name: displayName,
      emailVerified: new Date(),
      profile: {
        create: {
          name: displayName,
          onboarded: false,
        },
      },
      oauth_accounts: {
        create: {
          provider: "apple",
          provider_id: applePayload.sub,
          email,
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
