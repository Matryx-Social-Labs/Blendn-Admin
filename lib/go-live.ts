import { z } from "zod"

import { checkinSchema } from "./validations/event"
import { PING_INTERVAL_MINUTES } from "./presence"
import { PRESENCE_CUTOFF_MINUTES } from "./presence-sessions"

/**
 * Go Live: the window a person opens at a venue (docs/HOTSPOTS.md, plan v2 step 4).
 *
 * You are visible at a venue only for a time-boxed window you chose, and the
 * window is a row with an expiry (`event_check_ins.expires_at`) — when it lapses
 * you are gone with no further action. Pure, so the arithmetic is testable
 * without a database; the route and the presence ping apply it.
 */

/** The fixed windows, in minutes. 20, 45 and 60 stay free (ROADMAP, Pricing). */
export const GO_LIVE_MINUTES = [20, 45, 60] as const
export type GoLiveMinutes = (typeof GO_LIVE_MINUTES)[number]

/** "Stay" opens like the longest fixed window, then follows the person. */
export const STAY_FIRST_MINUTES = 60

/** The most "stay" can run from the moment it was chosen. */
export const STAY_MAX_MINUTES = 4 * 60

/**
 * How far one in-fence ping pushes a "stay" window ahead.
 *
 * Past the next ping and the presence cutoff together, so a ping that arrives
 * late — a backgrounded app, a slow network — still finds the window open
 * (PL-U03). Silence ends it this long after the last ping that said "inside".
 */
export const STAY_EXTEND_MINUTES = PING_INTERVAL_MINUTES + PRESENCE_CUTOFF_MINUTES + 5

const minutes = (n: number) => n * 60_000
const earlier = (a: Date, b: Date) => (a <= b ? a : b)

/**
 * The request body: where you are, and for how long. Any other number of
 * minutes is a 400 (PL-U02).
 */
export const goLiveSchema = z.union([
  checkinSchema.extend({ minutes: z.union([z.literal(20), z.literal(45), z.literal(60)]) }),
  checkinSchema.extend({ stay: z.literal(true) }),
])
export type GoLiveInput = z.infer<typeof goLiveSchema>

export interface LiveWindow {
  expiresAt: Date
  /** Non-null for "stay": the cap an in-fence ping may extend to. */
  stayUntil: Date | null
}

/**
 * The window a Go Live opens.
 *
 * Never past the venue's reset (`dayEnd`): a session open at the reset ends
 * `expired` (D-4), and tomorrow is a new room with new pseudonyms. Never
 * shorter than a window already open: going live again while live extends,
 * it does not cut short (an accidental "20" after a "60" must not end you
 * early — checking out is how you leave).
 */
export function goLiveWindow(
  choice: { minutes: GoLiveMinutes } | { stay: true },
  now: Date,
  dayEnd: Date,
  current: Date | null = null
): LiveWindow {
  const stay = "stay" in choice
  const length = stay ? STAY_FIRST_MINUTES : choice.minutes
  const asked = new Date(now.getTime() + minutes(length))
  const kept = current && current > asked ? current : asked
  return {
    expiresAt: earlier(kept, dayEnd),
    stayUntil: stay ? earlier(new Date(now.getTime() + minutes(STAY_MAX_MINUTES)), dayEnd) : null,
  }
}

/**
 * Where an in-fence ping moves a "stay" window, or null when it does not.
 *
 * Only "stay" extends; a fixed window ends when it said it would. The caller
 * asks only on a ping that put the person inside the fence, and only while the
 * window is still open — an expired window is ended, not revived.
 */
export function stayExtension(window: { expiresAt: Date; stayUntil: Date | null }, now: Date): Date | null {
  if (!window.stayUntil || window.expiresAt <= now) return null
  const next = earlier(new Date(now.getTime() + minutes(STAY_EXTEND_MINUTES)), window.stayUntil)
  return next > window.expiresAt ? next : null
}
