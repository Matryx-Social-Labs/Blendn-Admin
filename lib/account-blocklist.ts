// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { db } from "./db"
import { logger } from "./logger"

/**
 * Accounts deleted or suspended recently enough that a signed access token
 * for them could still exist, and accounts whose phones were signed out
 * (`mobile_sessions_revoked_at`: Settings, a password change or reset —
 * SCRUM-603), whose tokens from before that moment are refused. See
 * `accountBlockReason` in lib/mobile-auth.ts for why this is the one database
 * read on the request path, and why it is bounded. Its own module so a
 * dashboard action can call `blockAccountNow` without importing the JWT stack.
 */
const BLOCKLIST_REFRESH_MS = 30 * 1000
const BLOCKLIST_LOOKBACK_MS = 20 * 60 * 1000 // an access token's life, plus a margin
let blocklist = new Set<string>()
/** userId → when its phones were signed out, in ms. */
let phonesEndedAt = new Map<string, number>()
let blocklistFetchedAt = 0
let blocklistRefresh: Promise<void> | null = null

async function refreshBlocklist(): Promise<void> {
  const since = new Date(Date.now() - BLOCKLIST_LOOKBACK_MS)
  const rows = await db.user.findMany({
    where: { OR: [{ deletedAt: { gte: since } }, { suspended_at: { gte: since } }, { mobile_sessions_revoked_at: { gte: since } }] },
    select: { id: true, deletedAt: true, suspended_at: true, mobile_sessions_revoked_at: true },
  })
  const recent = (at: Date | null) => at !== null && at >= since
  blocklist = new Set(rows.filter((r) => recent(r.deletedAt) || recent(r.suspended_at)).map((r) => r.id))
  phonesEndedAt = new Map(
    rows.filter((r) => recent(r.mobile_sessions_revoked_at)).map((r) => [r.id, r.mobile_sessions_revoked_at!.getTime()])
  )
  blocklistFetchedAt = Date.now()
}

/** The action that signed somebody's phones out tells this process at once. */
export function phonesSignedOutNow(userId: string, at: Date): void {
  phonesEndedAt.set(userId, Math.max(phonesEndedAt.get(userId) ?? 0, at.getTime()))
}

/** The route that deleted or suspended somebody tells this process at once. */
export function blockAccountNow(userId: string): void {
  blocklist.add(userId)
}

/**
 * Refused: the account was deleted or suspended, or its phones were signed out
 * at or after this token was issued (`issuedAt`, the JWT's `iat`, in seconds —
 * a tie goes to the sign-out, as in lib/session-revocation.ts).
 */
export async function recentlyBlocked(userId: string, issuedAt: number): Promise<boolean> {
  if (Date.now() - blocklistFetchedAt > BLOCKLIST_REFRESH_MS) {
    // One refresh at a time; a failure keeps the previous set rather than
    // failing every request, and is retried on the next.
    blocklistRefresh ??= refreshBlocklist()
      .catch((error) => {
        logger.warn("Could not refresh the blocked-accounts set", {
          error: error instanceof Error ? error.message : String(error),
        })
        blocklistFetchedAt = Date.now()
      })
      .finally(() => {
        blocklistRefresh = null
      })
    await blocklistRefresh
  }
  if (blocklist.has(userId)) return true
  const phonesEnded = phonesEndedAt.get(userId)
  return phonesEnded !== undefined && issuedAt * 1000 <= phonesEnded
}

