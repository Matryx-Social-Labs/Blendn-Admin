import { NextRequest } from "next/server"
import { z } from "zod"

import { readJson } from "@/lib/api-input"
import { serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { offersFromPlaces, setOffersFromPlaces } from "@/lib/offers/person"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

/**
 * GET / PUT /api/mobile/me/offers — "Offers from places", one switch for every
 * venue (step 12 review M6). `{ enabled }`: on unless turned off; off, no
 * venue's offer reaches you (the send leaves you out of every audience). Only
 * a real boolean changes it.
 */
const putSchema = z.object({ enabled: z.boolean() }).strict()

export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "me-offers", authUser.userId))
    if (limited) return limited
    const res = await successResponse({ enabled: await offersFromPlaces(authUser.userId) })
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
    const res = await successResponse({ enabled: await setOffersFromPlaces(authUser.userId, parsed.data.enabled) })
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Set offers setting failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to save the setting")
  }
}
