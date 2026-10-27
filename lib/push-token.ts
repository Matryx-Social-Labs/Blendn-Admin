import { Expo } from "expo-server-sdk"

import { db } from "./db"
import { logger } from "./logger"
import { hit, StoreUnavailable } from "./rate-limit-store"

/**
 * Registering a push token (SCRUM-668).
 *
 * One device, one account: the token is unique, and registering it MOVES it to
 * the caller. The device that presents the token is the one that receives
 * pushes sent to it, and the client registers again on every launch, so the
 * caller who holds the phone is the right owner. Before, `(user_id, token)`
 * was the key and a second account on the same phone left the first account's
 * row behind -- the first account's DM previews rang the second person's
 * phone.
 *
 * What stops that being a lever: only a real Expo token is accepted, a move
 * between accounts is logged (never the token), and one caller may take over
 * only so many tokens an hour -- counted only on a move (the row is somebody
 * else's), so it throttles the mover's own account and can never refuse a device
 * registering a token nobody holds or its own.
 *
 * Residual risk until SCRUM-757: whoever holds a device's full token can move
 * its pushes to their own account (not read them: pushes go to the device).
 * The owner's phone takes it back on its next launch, because the client
 * registers on every launch. Nothing leaks to the caller either way: pushes
 * go to the device, not to whoever registered it.
 *
 * ponytail: the client sends only `{ token, platform }`, so a move cannot be
 * bound to an installation id; with one, a token would move only when the id
 * matches or the old row is stale (SCRUM-757).
 */

/** Generous for a person switching accounts on a phone or two; a ceiling for somebody collecting tokens. */
export const MAX_TOKEN_MOVES_PER_HOUR = 5
const CLOSED = { failClosed: true } as const
const MOVE_WINDOW_MS = 60 * 60 * 1000
/** No real Expo token is near this. */
const MAX_TOKEN_CHARS = 200

export type Registered = { ok: true } | { ok: false; reason: "not_a_token" | "too_many_moves" | "unavailable" }

/** The two spellings Expo issues, with something inside the brackets. */
const EXPO_TOKEN_SHAPE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/

/** `ExponentPushToken[...]` / `ExpoPushToken[...]`, of a length no real one reaches. */
export function isRegisterableToken(token: string): boolean {
  return token.length <= MAX_TOKEN_CHARS && EXPO_TOKEN_SHAPE.test(token) && Expo.isExpoPushToken(token)
}

export async function registerPushToken(
  userId: string,
  token: string,
  platform: "ios" | "android",
  /** Which Android channels this install created; only written when the app says (an older build must not lose it). */
  channelSet?: number
): Promise<Registered> {
  if (!isRegisterableToken(token)) return { ok: false, reason: "not_a_token" }

  /*
   * Decided under the token's row lock, in one transaction, so a move is
   * counted and logged exactly when it is made: reading the holder first and
   * writing after let two concurrent registers both see "nobody" (or the same
   * holder), and a move slipped past the limit and the log.
   *
   *   1. INSERT ... ON CONFLICT DO NOTHING: a token nobody holds is simply created.
   *   2. Otherwise lock the holder's row. Own row: refresh it. Somebody else's:
   *      that is a move -- limited per caller, and refused with the row
   *      untouched when over.
   */
  const outcome: Registered & { movedFrom?: string } = await db
    .$transaction(async (tx): Promise<Registered & { movedFrom?: string }> => {
    const now = new Date()
    for (let attempt = 0; attempt < 3; attempt++) {
      const created = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO push_tokens (id, user_id, token, platform, channel_set, created_at, updated_at)
        VALUES (gen_random_uuid(), ${userId}, ${token}, ${platform}, ${channelSet ?? null}, ${now}, ${now})
        ON CONFLICT (token) DO NOTHING
        RETURNING id`
      if (created.length > 0) return { ok: true }

      const [held] = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT user_id FROM push_tokens WHERE token = ${token} FOR UPDATE`
      if (!held) continue // signed out between the two statements: create it

      if (held.user_id === userId) {
        await tx.$executeRaw`UPDATE push_tokens SET platform = ${platform}, channel_set = COALESCE(${channelSet ?? null}::smallint, channel_set), updated_at = ${now} WHERE token = ${token}`
        return { ok: true }
      }

      /*
       * A move: counted FIRST, in the caller's own bucket, only when the row is somebody
       * else's. Counting before the write is what makes the limit hold under concurrency
       * (peek-then-hit let parallel moves all pass the peek). A refused attempt costs the
       * caller's allowance too, which is fine: the key is the mover's own account, so it
       * only ever throttles the mover, never the token's holder. A device registering a
       * token nobody holds, or its own, never reaches this line. Fail closed: without the
       * limiter's store a move is refused, not waved through.
       */
      const moves = await hit(`push-token-move:${userId}`, MOVE_WINDOW_MS, CLOSED)
      if (moves.count > MAX_TOKEN_MOVES_PER_HOUR) return { ok: false, reason: "too_many_moves" }
      await tx.$executeRaw`UPDATE push_tokens SET user_id = ${userId}, platform = ${platform}, channel_set = COALESCE(${channelSet ?? null}::smallint, channel_set), updated_at = ${now} WHERE token = ${token}`
      return { ok: true, movedFrom: held.user_id }
    }
    throw new Error("push token register: row kept appearing and disappearing")
    })
    .catch((error: unknown) => {
      // The limiter's store down, or a transaction that waited past Prisma's timeout (P2028) on a stalled limiter: try again.
      if (error instanceof StoreUnavailable || (error as { code?: string })?.code === "P2028") {
        return { ok: false as const, reason: "unavailable" as const }
      }
      throw error
    })

  if (!outcome.ok) {
    if (outcome.reason === "too_many_moves") logger.warn("Push token move refused: too many in an hour", { toUserId: userId, platform })
    return outcome
  }
  if (outcome.movedFrom) logger.info("Push token moved between accounts", { fromUserId: outcome.movedFrom, toUserId: userId, platform })
  return { ok: true }
}
