import jwt from "jsonwebtoken"
import { appleRevokeConfig, type AppleRevokeConfig } from "./env"

/**
 * Sign in with Apple: revoke the person's grant when their account is deleted
 * (App Store Review Guideline 5.1.1(v)). The app sends a fresh
 * `authorizationCode` with the delete; it is exchanged for a refresh token at
 * `/auth/token`, and that token is revoked at `/auth/revoke`, which removes the
 * app from the person's "Sign in with Apple" list.
 *
 * Best effort, always: a deletion is never held up by Apple. Every outcome is
 * returned for the caller to log and audit. Neither the code nor a token is
 * ever logged or returned.
 */

const APPLE = "https://appleid.apple.com"
/** Apple allows up to six months; the secret is minted per call, so minutes are plenty. */
const CLIENT_SECRET_TTL_S = 5 * 60
/** Each of the two calls. A deletion waits at most twice this for Apple. */
const APPLE_TIMEOUT_MS = 5_000

export type AppleRevokeOutcome =
  | { outcome: "revoked" }
  /** `different_apple_id`: the code was for another Apple ID than the one linked, whose grant is not ours to revoke. */
  | { outcome: "skipped"; reason: "no_code" | "not_configured" | "different_apple_id" }
  | { outcome: "failed"; reason: string }

/**
 * The `client_secret` Apple asks for: an ES256 JWT signed with the Sign in
 * with Apple key, `iss` the team, `sub` the client id, `aud` Apple.
 */
export function appleClientSecret(config: AppleRevokeConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  return jwt.sign(
    {
      iss: config.teamId,
      iat: nowSeconds,
      exp: nowSeconds + CLIENT_SECRET_TTL_S,
      aud: APPLE,
      sub: config.clientId,
    },
    config.privateKey,
    { algorithm: "ES256", keyid: config.keyId }
  )
}

/** POST a form to Apple. Throws with the status and Apple's `error` word (never the body's tokens). */
async function postForm(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${APPLE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // Not JSON: nothing in it is ours to read.
  }
  if (!res.ok) {
    const word = typeof body.error === "string" ? body.error.slice(0, 64) : "unknown"
    throw new Error(`${path} answered ${res.status} (${word})`)
  }
  return body
}

/**
 * Exchange the code and revoke the grant, only if the code belongs to
 * `linkedSub`, the Apple user id on the account being deleted. Somebody who
 * picks a different Apple ID in the sheet hands us a code for a grant that is
 * not this account's; that one is left alone. Never throws.
 */
export async function revokeAppleAuthorization(code: string | null | undefined, linkedSub: string): Promise<AppleRevokeOutcome> {
  if (!code) return { outcome: "skipped", reason: "no_code" }
  const config = appleRevokeConfig()
  if (!config) return { outcome: "skipped", reason: "not_configured" }
  try {
    const clientSecret = appleClientSecret(config)
    const tokens = await postForm("/auth/token", {
      client_id: config.clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    })
    // The refresh token revokes the whole grant; an access token (1 h) is Apple's accepted fallback.
    const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : null
    const access = typeof tokens.access_token === "string" ? tokens.access_token : null
    if (!refresh && !access) return { outcome: "failed", reason: "no token in Apple’s answer" }
    /*
     * Whose grant this is. The id_token came straight from Apple over TLS in
     * answer to our own signed request, so reading its `sub` needs no second
     * signature check; without one, nothing is revoked.
     */
    const idToken = typeof tokens.id_token === "string" ? jwt.decode(tokens.id_token) : null
    const sub = idToken && typeof idToken === "object" ? idToken.sub : undefined
    if (!sub) return { outcome: "failed", reason: "no id_token sub in Apple’s answer" }
    if (sub !== linkedSub) return { outcome: "skipped", reason: "different_apple_id" }
    await postForm("/auth/revoke", {
      client_id: config.clientId,
      client_secret: clientSecret,
      token: (refresh ?? access)!,
      token_type_hint: refresh ? "refresh_token" : "access_token",
    })
    return { outcome: "revoked" }
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}
