// Relative imports only: lib/mobile-auth.ts uses this and is reachable from
// server.ts (__tests__/server-import-boundary.test.ts).
import { logger } from "../logger"
import { checkIdentityKeywords } from "./keyword-filter"

/** The longest display name a provider may hand us. Apple's `fullName` is sent by the app, unsigned. */
export const OAUTH_NAME_MAX = 64

/**
 * A display name from Sign in with Apple or Google, fit to store, or null.
 *
 * Apple's `fullName` comes from the app, not from Apple's signed token, so it
 * is whatever the client sent; Google's is the account's own. Either way it
 * lands on a card strangers read (PR #755 review, M2). Whitespace collapsed,
 * capped at `OAUTH_NAME_MAX` characters (not UTF-16 units, so an emoji is not
 * cut in half), and held to the identity list: an unambiguous slur gives no
 * name at all, and onboarding asks for one, rather than failing the sign-in.
 * An ambiguous word (a real name) is kept and logged for review.
 */
export function oauthDisplayName(raw: string | null | undefined): string | null {
  const name = [...(raw ?? "").replace(/\s+/g, " ").trim()].slice(0, OAUTH_NAME_MAX).join("").trim()
  if (!name) return null
  const keyword = checkIdentityKeywords(name)
  if (keyword?.action === "hide") {
    logger.info("Sign-in name refused; the account is made without one", { source: keyword.source, matched: keyword.matched })
    return null
  }
  if (keyword) logger.info("Sign-in name flagged for review", { source: keyword.source, matched: keyword.matched })
  return name
}
