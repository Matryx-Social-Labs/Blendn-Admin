import type { Prisma } from "@prisma/client"

/**
 * Suspension, and everywhere it has to reach.
 *
 * The reviewer's UI said suspending "blocks the account everywhere and signs it
 * out". It did neither. The transaction wrote `suspended_at`, revoked mobile
 * refresh tokens, and called `session.deleteMany()` — which is a no-op, because
 * the strategy is `jwt` and there are no `Session` rows to delete. A suspended
 * host kept a valid dashboard cookie for up to thirty days, stayed connected on
 * the socket, stayed a member of every room, and kept receiving pushes.
 *
 * That is worse than not having the feature. A moderator reads the copy, sees
 * the row go green, and believes they have acted.
 *
 * ```
 *   suspend(user)
 *        │
 *        ├─ users.suspended_at        the fact
 *        ├─ mobile_refresh_tokens     no new app session
 *        ├─ push_tokens               no notifications
 *        └─ chat_group_members        no posting, in any room
 *
 *   and, on the read side, four gates that must all consult it:
 *        authorize()                  dashboard sign-in
 *        jwt callback                 the cookie already issued
 *        socket-auth                  attendee realtime
 *        socket-ops-auth              dashboard realtime
 * ```
 *
 * ## Why the channel list is a constant
 *
 * R14: the blast radius is enumerated here rather than left to whoever
 * implements the next channel. `__tests__/suspension-blast-radius.test.ts`
 * reads this list and asserts each entry is actually wired — so adding a new
 * user-reachable surface without adding it here fails the build, instead of
 * being discovered the first time a banned person keeps posting.
 */

/** Every place a suspension has to land. The test reads this. */
export const SUSPENSION_WRITE_CHANNELS = [
  "user.suspended_at",
  "mobile_refresh_tokens",
  "push_tokens",
  "chat_group_members",
] as const

/** Every gate that has to consult it. The test reads this too. */
export const SUSPENSION_READ_GATES = [
  { file: "lib/auth.ts", what: "dashboard sign-in and the live cookie" },
  { file: "lib/socket-server.ts", what: "attendee realtime handshake" },
  { file: "lib/socket-ops-auth.ts", what: "dashboard realtime handshake" },
  { file: "lib/mobile-auth.ts", what: "mobile token issue and refresh" },
] as const

/*
 * `lib/socket-auth.ts` is deliberately not on that list.
 *
 * It authorises *room joins*, not the connection, and it already rejects a
 * `banned` membership -- which `applySuspension` writes. So it is covered by
 * the write side rather than by reading `suspended_at` again, and adding a
 * second read there would be a third place answering one question.
 *
 * Worth stating because the first draft of the list named that file instead of
 * `socket-server.ts`, and the test caught it.
 */

/**
 * A Prisma transaction client, or the client itself.
 *
 * Suspension is always part of a larger decision — resolving a report, an admin
 * action — so this takes the caller's transaction rather than opening its own.
 * A suspension that commits while the report that caused it rolls back is a
 * ban with no recorded reason.
 */
type Tx = Prisma.TransactionClient

/**
 * Apply a suspension across every channel.
 *
 * Idempotent: re-suspending an already-suspended account rewrites the same
 * facts. `suspended_at` is deliberately overwritten rather than preserved —
 * the second suspension is the current one.
 */
export async function applySuspension(
  tx: Tx,
  userId: string,
  suspendedBy: string
): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: { suspended_at: new Date(), suspended_by: suspendedBy },
  })

  // No new app session. Without this the suspension only bites when the
  // current refresh token expires — up to thirty days of continued access.
  await tx.mobile_refresh_tokens.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  })

  // No notifications. A suspended account that keeps receiving pushes is still
  // being told about a room it cannot enter.
  await tx.push_tokens.deleteMany({ where: { user_id: userId } })

  /*
   * No posting, in any room.
   *
   * `banned` rather than `left`: the row is kept either way — `anonymous_name`
   * lives on it and deleting it would blank the pseudonyms on every historical
   * message — but `left` reads as "the window closed", which is what the
   * lifecycle sweeper writes. A moderator looking at this row later should be
   * able to tell the difference between a room that ended and a person who was
   * removed from it.
   */
  await tx.chat_group_members.updateMany({
    where: { user_id: userId, status: { in: ["active", "muted"] } },
    data: { status: "banned" },
  })
}

/**
 * Lift a suspension.
 *
 * Deliberately narrow. It clears the fact and nothing else: refresh tokens stay
 * revoked (they sign in again), push tokens stay deleted (the device
 * re-registers on next launch), and chat membership stays `banned`.
 *
 * Restoring room membership automatically would silently re-admit someone to
 * every room they were ever in, including ones whose event ended months ago and
 * whose other members have no idea. Re-entry goes through the same door as
 * anyone else's: check in again.
 */
export async function liftSuspension(tx: Tx, userId: string): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: { suspended_at: null, suspended_by: null },
  })
}
