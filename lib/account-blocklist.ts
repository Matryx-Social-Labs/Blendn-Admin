// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { db } from "./db"
import { logger } from "./logger"

/**
 * Accounts deleted or suspended recently enough that a signed access token
 * for them could still exist. See `accountBlockReason` in lib/mobile-auth.ts
 * for why this is the one database read on the request path, and why it is
 * bounded. Its own module so a dashboard action can call `blockAccountNow`
 * without importing the JWT stack.
 */
const BLOCKLIST_REFRESH_MS = 30 * 1000
const BLOCKLIST_LOOKBACK_MS = 20 * 60 * 1000 // an access token's life, plus a margin
let blocklist = new Set<string>()
let blocklistFetchedAt = 0
let blocklistRefresh: Promise<void> | null = null

async function refreshBlocklist(): Promise<void> {
  const since = new Date(Date.now() - BLOCKLIST_LOOKBACK_MS)
  const rows = await db.user.findMany({
    where: { OR: [{ deletedAt: { gte: since } }, { suspended_at: { gte: since } }] },
    select: { id: true },
  })
  blocklist = new Set(rows.map((r) => r.id))
  blocklistFetchedAt = Date.now()
}

/** The route that deleted or suspended somebody tells this process at once. */
export function blockAccountNow(userId: string): void {
  blocklist.add(userId)
}

export async function recentlyBlocked(userId: string): Promise<boolean> {
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
  return blocklist.has(userId)
}

