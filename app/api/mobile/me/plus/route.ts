import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { livePlus } from "@/lib/entitlements"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"

export const dynamic = "force-dynamic"

/**
 * GET /api/mobile/me/plus — do I have Blendn+, and until when (step 11).
 *
 * The app's one answer to "is Plus unlocked": after a purchase it polls this
 * until the store's webhook has granted it, because the app saying "bought"
 * writes nothing (lib/revenuecat-webhook.ts). A Night Pass counts as Plus.
 * Read from the database, never cached: per-person state is never served from
 * a shared cache (SEC-15). Not a gate — every gate asks on the server.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const live = await livePlus(authUser.userId)
    const res = await successResponse({
      active: live !== null,
      product: live?.product ?? null,
      source: live?.source ?? null,
      expiresAt: live?.expiresAt?.toISOString() ?? null,
    })
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Get Plus status failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load Blendn+")
  }
}
