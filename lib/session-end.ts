// Relative imports: reachable from server.ts (__tests__/server-import-boundary.test.ts).
import type { Prisma } from "@prisma/client"

import type { RevokedReason } from "./mobile-auth"

import { phonesSignedOutNow } from "./account-blocklist"
import { evictUserSockets } from "./socket-server"

/**
 * Ending a person's sessions, one way for every caller (SCRUM-603): Settings'
 * two Sign out rows, a password change, a reset link. Each piece used to be
 * written at each caller, and each caller had a different subset — the reset
 * revoked the phones' refresh tokens and nothing else, Settings kept their
 * push tokens, and nobody closed a live socket.
 *
 * Suspension and deletion are not here: they end the whole account, not the
 * sessions from before a moment, and each writes all of this and more itself
 * (lib/suspension.ts, pinned by suspension-blast-radius.test.ts; the erasure
 * in app/api/mobile/account/route.ts, by deletion-evicts-sockets.itest.ts).
 */

/**
 * In the caller's transaction: every phone session ends, at the returned `at`.
 * Refresh tokens are revoked, push tokens go (a phone that can no longer sign in
 * can no longer delete its own, and kept receiving the account's notifications,
 * DM text included), and the stamp makes every access token issued until now
 * refused. Returns how many refresh tokens were live.
 *
 * `reason` is stored on each revoked refresh token, so the phone that presents
 * it next is told why it was signed out (`refusedRefreshReason`, Flow 15).
 *
 * The user row is locked **first**, and `at` is read only once the lock is held.
 * A refresh takes the same row `FOR SHARE` before it stores its new token
 * (app/api/mobile/auth/refresh/route.ts), so the two cannot interleave: either
 * the refresh committed first, and its new row is among those revoked below and
 * its access token was issued before `at`; or this committed first, and the
 * refresh sees the stamp and refuses. `FOR NO KEY UPDATE` is what a plain
 * update of the row takes, and conflicts with `FOR SHARE`, but not with the
 * foreign-key check of a refresh-token insert.
 */
export async function endPhoneSessions(
  tx: Prisma.TransactionClient,
  userId: string,
  reason: RevokedReason
): Promise<{ live: number; at: Date }> {
  await tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`
  const at = new Date()
  await tx.user.update({ where: { id: userId }, data: { mobile_sessions_revoked_at: at } })
  const { count } = await tx.mobile_refresh_tokens.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: at, revoked_reason: reason },
  })
  await tx.push_tokens.deleteMany({ where: { user_id: userId } })
  return { live: count, at }
}

/**
 * After the commit, never inside it (a rollback would have signed out somebody
 * whose sessions did not end): this process refuses the old access tokens at
 * once rather than at its next blocklist refresh, and the phones' live
 * sockets close. A reconnect meets the handshake's own check of the stamp.
 */
export function phoneSessionsEnded(userId: string, at: Date): void {
  phonesSignedOutNow(userId, at)
  evictUserSockets(userId, "mobile")
}

/**
 * After the commit that stamped `sessions_revoked_at` or `password_changed_at`:
 * the dashboard's live sockets close, so an ended session stops receiving the
 * live room and the moderation queue now rather than at its next reload. A
 * reconnect meets `isRevoked` in `authenticateDashboardSocket`.
 */
export function dashboardSessionsEnded(userId: string): void {
  evictUserSockets(userId, "dashboard")
}
