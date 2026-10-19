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
/**
 * The longest the set may be served while it is refreshed in the background.
 * Past it (a quiet spell, an instance that was idle) the request waits for the
 * refresh, exactly as every request used to: this is a security list, and "stale
 * while revalidating" must not become "stale for as long as nobody asked".
 */
const BLOCKLIST_MAX_STALE_MS = 2 * 30 * 1000
const BLOCKLIST_LOOKBACK_MS = 20 * 60 * 1000 // an access token's life, plus a margin

/*
 * On globalThis, not in module scope (SCRUM-603). Next bundles its own copy of
 * this module per layer, so the dashboard action that suspended somebody or
 * signed their phones out told a different copy from the one the mobile
 * routes read: driven on staging, a signed-out phone's access token still
 * answered 200 four seconds later and 401 only at the next refresh, 29 s on.
 * The socket server's `io` is shared the same way, for the same reason.
 *
 * What an action says at once is kept apart from what the database last said,
 * so a refresh that started before the action committed cannot drop it.
 */
interface BlocklistState {
  /** From the database: deleted or suspended in the lookback. */
  blocked: Set<string>
  /** From the database: userId → when its phones were signed out, in ms. */
  phonesEndedAt: Map<string, number>
  /** Said by an action in this process: userId → when, in ms. */
  blockedNow: Map<string, number>
  phonesEndedNow: Map<string, number>
  fetchedAt: number
  refresh: Promise<void> | null
}
const shared = globalThis as typeof globalThis & { __blendnBlocklist?: BlocklistState }
const state: BlocklistState = (shared.__blendnBlocklist ??= {
  blocked: new Set(),
  phonesEndedAt: new Map(),
  blockedNow: new Map(),
  phonesEndedNow: new Map(),
  fetchedAt: 0,
  refresh: null,
})

async function refreshBlocklist(): Promise<void> {
  const since = new Date(Date.now() - BLOCKLIST_LOOKBACK_MS)
  const rows = await db.user.findMany({
    where: { OR: [{ deletedAt: { gte: since } }, { suspended_at: { gte: since } }, { mobile_sessions_revoked_at: { gte: since } }] },
    select: { id: true, deletedAt: true, suspended_at: true, mobile_sessions_revoked_at: true },
  })
  const recent = (at: Date | null) => at !== null && at >= since
  state.blocked = new Set(rows.filter((r) => recent(r.deletedAt) || recent(r.suspended_at)).map((r) => r.id))
  state.phonesEndedAt = new Map(
    rows.filter((r) => recent(r.mobile_sessions_revoked_at)).map((r) => [r.id, r.mobile_sessions_revoked_at!.getTime()])
  )
  for (const said of [state.blockedNow, state.phonesEndedNow]) {
    for (const [id, at] of said) if (at < since.getTime()) said.delete(id)
  }
  state.fetchedAt = Date.now()
}

/** The action that signed somebody's phones out tells this process at once. */
export function phonesSignedOutNow(userId: string, at: Date): void {
  state.phonesEndedNow.set(userId, Math.max(state.phonesEndedNow.get(userId) ?? 0, at.getTime()))
}

/** The route that deleted or suspended somebody tells this process at once. */
export function blockAccountNow(userId: string): void {
  state.blockedNow.set(userId, Date.now())
}

/**
 * Refused: the account was deleted or suspended, or its phones were signed out
 * at or after this token was issued (`issuedAt`, the JWT's `iat`, in seconds —
 * a tie goes to the sign-out, as in lib/session-revocation.ts).
 */
export async function recentlyBlocked(userId: string, issuedAt: number): Promise<boolean> {
  const age = Date.now() - state.fetchedAt
  if (age > BLOCKLIST_REFRESH_MS) {
    // One refresh at a time; a failure keeps the previous set rather than
    // failing every request, and is retried on the next.
    state.refresh ??= refreshBlocklist()
      .catch((error) => {
        logger.warn("Could not refresh the blocked-accounts set", {
          error: error instanceof Error ? error.message : String(error),
        })
        // Never loaded (fetchedAt 0): stay unloaded, so the next request awaits a
        // retry instead of being served an empty set as fresh for 60 s.
        if (state.fetchedAt !== 0) state.fetchedAt = Date.now()
      })
      .finally(() => {
        state.refresh = null
      })
    // Every 30 s one request used to wait here for a full User query. Within
    // the stale limit it is answered from the set it has, which an action in
    // this process has already amended (`blockAccountNow`, `phonesSignedOutNow`
    // are applied below). The first load (fetchedAt 0) is always past the limit.
    if (age > BLOCKLIST_MAX_STALE_MS) await state.refresh
  }
  if (state.blocked.has(userId) || state.blockedNow.has(userId)) return true
  const phonesEnded = Math.max(state.phonesEndedAt.get(userId) ?? 0, state.phonesEndedNow.get(userId) ?? 0)
  return phonesEnded > 0 && issuedAt * 1000 <= phonesEnded
}
