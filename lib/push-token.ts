import { Expo } from "expo-server-sdk"

import { db } from "./db"
import { logger } from "./logger"
import { hit } from "./rate-limit-store"

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
 * only so many tokens an hour. Nothing leaks to the caller either way: pushes
 * go to the device, not to whoever registered it.
 *
 * ponytail: the client sends only `{ token, platform }`, so a move cannot be
 * bound to an installation id; with one, a token would move only when the id
 * matches or the old row is stale (SCRUM-757).
 */

/** Generous for a person switching accounts on a phone or two; a ceiling for somebody collecting tokens. */
export const MAX_TOKEN_MOVES_PER_HOUR = 5
const MOVE_WINDOW_MS = 60 * 60 * 1000
/** No real Expo token is near this. */
const MAX_TOKEN_CHARS = 200

export type Registered = { ok: true } | { ok: false; reason: "not_a_token" | "too_many_moves" }

/** The two spellings Expo issues, with something inside the brackets. */
const EXPO_TOKEN_SHAPE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/

/** `ExponentPushToken[...]` / `ExpoPushToken[...]`, of a length no real one reaches. */
export function isRegisterableToken(token: string): boolean {
  return token.length <= MAX_TOKEN_CHARS && EXPO_TOKEN_SHAPE.test(token) && Expo.isExpoPushToken(token)
}

export async function registerPushToken(userId: string, token: string, platform: "ios" | "android"): Promise<Registered> {
  if (!isRegisterableToken(token)) return { ok: false, reason: "not_a_token" }

  const holder = await db.push_tokens.findUnique({ where: { token }, select: { user_id: true } })
  const movedFrom = holder && holder.user_id !== userId ? holder.user_id : null
  if (movedFrom) {
    const { count } = await hit(`push-token-move:${userId}`, MOVE_WINDOW_MS)
    if (count > MAX_TOKEN_MOVES_PER_HOUR) {
      logger.warn("Push token move refused: too many in an hour", { toUserId: userId, platform })
      return { ok: false, reason: "too_many_moves" }
    }
  }

  const now = new Date()
  // One native INSERT ... ON CONFLICT (token): accounts registering at once settle on one holder, no 500.
  await db.push_tokens.upsert({
    where: { token },
    update: { user_id: userId, platform, updated_at: now },
    create: { user_id: userId, token, platform, created_at: now, updated_at: now },
  })
  if (movedFrom) logger.info("Push token moved between accounts", { fromUserId: movedFrom, toUserId: userId, platform })
  return { ok: true }
}
