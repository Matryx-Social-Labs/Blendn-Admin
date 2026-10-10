import { NextRequest } from "next/server"
import { z } from "zod"

import { readJson } from "@/lib/api-input"
import { serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { PAYWALL_TRIGGERS, PRODUCT_EVENTS, record } from "@/lib/product-events"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

const STEP = {
  shown: PRODUCT_EVENTS.paywall_shown,
  dismissed: PRODUCT_EVENTS.paywall_dismissed,
  purchase_started: PRODUCT_EVENTS.paywall_purchase_started,
  purchased: PRODUCT_EVENTS.paywall_purchased,
  restored: PRODUCT_EVENTS.paywall_restored,
} as const

const bodySchema = z.object({
  event: z.enum(Object.keys(STEP) as [keyof typeof STEP, ...(keyof typeof STEP)[]]),
  trigger: z.enum(PAYWALL_TRIGGERS),
})

/**
 * POST /api/mobile/me/plus/paywall-events — what the Blendn+ paywall did, and
 * what opened it (step 11). Measurement only: the app keeps the cooldowns
 * (never during onboarding, check-in or chat; at most one a session), and
 * nothing here unlocks anything — a "purchased" here grants nothing; the
 * store's webhook does.
 */
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "paywall-events", authUser.userId))
    if (limited) return limited

    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    record({ name: STEP[parsed.data.event], userId: authUser.userId, entityKind: parsed.data.trigger })
    return successResponse({ recorded: true })
  } catch (error) {
    logger.error("Record paywall event failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to record")
  }
}
