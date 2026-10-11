import { NextRequest } from "next/server"
import { z } from "zod"

import { isUuid, readJson } from "@/lib/api-input"
import {
  ErrorCode,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { reportOffer } from "@/lib/offers/person"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

interface RouteParams {
  params: Promise<{ offerId: string }>
}

const bodySchema = z
  .object({
    reason: z.enum(["offensive", "misleading", "spam", "unsafe", "other"]),
    description: z.string().trim().max(500).optional(),
  })
  .strict()

/**
 * POST /api/mobile/offers/:offerId/report — "Report this offer" (step 12).
 *
 * Into the reports queue every other report goes to (`message_reports`,
 * `message_type 'venue_offer'`), with the offer's words as they read. Only
 * someone it was sent to can report it (404 otherwise, the same as for no
 * offer); a second report while the first is pending is 409 `CONFLICT`.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { offerId } = await params
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("safety", "offer-report", authUser.userId))
    if (limited) return limited
    if (!isUuid(offerId)) return notFoundResponse("Offer not found")
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const outcome = await reportOffer(authUser.userId, offerId, parsed.data.reason, parsed.data.description || null)
    if (outcome === "not_found") return notFoundResponse("Offer not found")
    if (outcome === "already") return errorResponse("You've already reported this offer. We're looking at it.", 409, ErrorCode.CONFLICT)
    return successResponse({ reported: true })
  } catch (error) {
    logger.error("Report offer failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to report the offer")
  }
}
