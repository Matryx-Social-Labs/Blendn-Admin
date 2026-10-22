import { NextRequest } from "next/server"
import { z } from "zod"

import { readJson } from "@/lib/api-input"
import { serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

/**
 * GET / PUT /api/mobile/me/notification-preferences — which kinds of push a
 * person wants (Flow 9 · 9.6), under the master `push_enabled`.
 *
 *   - `matches` — Matches and friends: a match, a reveal and its request, a
 *     friend request and its acceptance, a board ask and its answer.
 *   - `crew`    — Your crew: an invite, "We're here", a Blend.
 *   - `night`   — After the night: "How was it?".
 *
 * All three default to true. They stop the PUSH only; the bell row is written
 * first (`recordNotification`). Offers have their own pair at `/me/offers`
 * (opt-in by App Store rule), and a DM, a room reply, an event's change and a
 * report's outcome have no switch here.
 *
 * PUT takes any non-empty subset of real booleans and answers all three. A
 * key it does not know is refused, so a typo changes nothing.
 */
const putSchema = z
  .object({ matches: z.boolean().optional(), crew: z.boolean().optional(), night: z.boolean().optional() })
  .strict()
  .refine((b) => b.matches !== undefined || b.crew !== undefined || b.night !== undefined, {
    message: "Say what to change",
  })

const select = { push_matches: true, push_crew: true, push_night: true } as const

/** No profile row reads as the defaults, as the send path does. */
const shape = (p: { push_matches: boolean; push_crew: boolean; push_night: boolean } | null) => ({
  matches: p?.push_matches ?? true,
  crew: p?.push_crew ?? true,
  night: p?.push_night ?? true,
})

export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "me-notification-preferences", authUser.userId))
    if (limited) return limited

    const res = await successResponse(shape(await db.profiles.findUnique({ where: { id: authUser.userId }, select })))
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Get notification preferences failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the settings")
  }
}

export async function PUT(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "me-notification-preferences", authUser.userId))
    if (limited) return limited

    const parsed = putSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { matches, crew, night } = parsed.data
    const data = {
      ...(matches !== undefined && { push_matches: matches }),
      ...(crew !== undefined && { push_crew: crew }),
      ...(night !== undefined && { push_night: night }),
    }

    const saved = await db.profiles.upsert({ where: { id: authUser.userId }, create: { id: authUser.userId, ...data }, update: data, select })
    const res = await successResponse(shape(saved))
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Set notification preferences failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to save the settings")
  }
}
