import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import { notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { openOffer } from "@/lib/offers/person"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

interface RouteParams {
  params: Promise<{ offerId: string }>
}

/**
 * GET /api/mobile/offers/:offerId — open an offer, and its door pass (step 12).
 *
 * The first open is what the venue's "opened" counts. While the offer can be
 * used (`state: "live"`), `pass` carries the code on the pass now and when it
 * turns (`rotatesAt`, every 30 s): the app asks again before then, and draws
 * the pass live around it. Staff type that code and tap "Redeemed" on the
 * dashboard; the next answer here says `redeemed`. `used_tonight`: another of
 * this venue's passes was redeemed tonight (one a night). A screenshot of the
 * pass carries a code that stops working within a minute.
 *
 * 404 for an offer you were not sent, the same as for no offer.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { offerId } = await params
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    // The pass screen asks every ~25 s while open; sixty a minute is a script.
    const limited = await rateLimit(request, userLimit("read", "offer", authUser.userId))
    if (limited) return limited
    if (!isUuid(offerId)) return notFoundResponse("Offer not found")

    const offer = await openOffer(authUser.userId, offerId)
    if (!offer) return notFoundResponse("Offer not found")
    const res = await successResponse({ offer })
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Open offer failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to open the offer")
  }
}
