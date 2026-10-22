import { NextRequest } from "next/server"
import { z } from "zod"

import { readJson } from "@/lib/api-input"
import { serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { offerSettings, setOfferSettings } from "@/lib/offers/person"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

/**
 * GET / PUT /api/mobile/me/offers — a person's two offer settings.
 *
 *   - `enabled` — "Offers from places", one switch for every venue (step 12
 *     review M6). On unless turned off; off, no venue's offer reaches you (the
 *     send leaves you out of every audience).
 *   - `pushes` — offer notifications (SCRUM-628). A venue's offer is a
 *     promotion, and App Store guideline 4.5.4 allows its push only after a
 *     yes given in the app, so it is off until you say yes. Off, offers still
 *     arrive, with no push. The yes is kept with when it was first given.
 *
 * PUT changes what it is given: each must be a real boolean, at least one, so
 * a missing or garbled answer changes nothing. "Not now" sends nothing.
 */
const putSchema = z
  .object({ enabled: z.boolean().optional(), pushes: z.boolean().optional() })
  .strict()
  .refine((b) => b.enabled !== undefined || b.pushes !== undefined, { message: "Say what to change" })

export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "me-offers", authUser.userId))
    if (limited) return limited
    const res = await successResponse(await offerSettings(authUser.userId))
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Get offers setting failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the setting")
  }
}

export async function PUT(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "me-offers", authUser.userId))
    if (limited) return limited
    const parsed = putSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const res = await successResponse(await setOfferSettings(authUser.userId, parsed.data))
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Set offers setting failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to save the setting")
  }
}
