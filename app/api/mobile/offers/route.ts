import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { myOffers } from "@/lib/offers/person"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

/**
 * GET /api/mobile/offers — the offers venues sent you, newest first (step 12).
 *
 * Each says which venue, its words, until when, and where it stands: `live`
 * (the pass can be shown), `redeemed`, `ended`. Reading the list opens
 * nothing: a venue's "opened" counts `GET /offers/:id`. Never cached: it is
 * one person's.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "offers", authUser.userId))
    if (limited) return limited

    const res = await successResponse({ offers: await myOffers(authUser.userId) })
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("List offers failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load your offers")
  }
}
