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
import { ADULTS_ONLY } from "@/lib/age"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { regularPrefs, setRegularPrefs } from "@/lib/offers/person"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

interface RouteParams {
  params: Promise<{ venueId: string }>
}

/**
 * Your two choices about a venue (step 12):
 *
 *   - `known` — "Let this venue know I'm a regular". Off until you say yes.
 *     The yes goes to the organisation that runs the venue now (`ownerName`):
 *     it sees your first name and how many nights you came in the last 30,
 *     and can greet you; off, it sees nothing of you again, from the next
 *     request (no cache). A new owner sees none of an earlier owner's yeses.
 *     Nothing about these choices is written to the audit log.
 *   - `offersMuted` — no offers from this venue.
 *
 * GET answers both. PUT changes what it is given: each must be a real
 * boolean, so a missing or garbled answer changes nothing (the opt-in that
 * stored yes when somebody said no, TESTING-PLAYBOOK §8). "Maybe later" in the
 * app sends nothing.
 *
 * `known: true` is refused 409 `VENUE_UNCLAIMED` while nobody runs the venue
 * on Blendn (nobody to tell), and 403 `AGE_RESTRICTED` without an adult age on
 * file. 404 for no such venue.
 */
const putSchema = z
  .object({ known: z.boolean().optional(), offersMuted: z.boolean().optional() })
  .strict()
  .refine((b) => b.known !== undefined || b.offersMuted !== undefined, { message: "Say what to change" })

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { venueId } = await params
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "venue-regular", authUser.userId))
    if (limited) return limited
    if (!isUuid(venueId)) return notFoundResponse("Venue not found")

    const prefs = await regularPrefs(authUser.userId, venueId)
    if (!prefs) return notFoundResponse("Venue not found")
    const res = await successResponse({ ...prefs })
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Get regular prefs failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load your choices")
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { venueId } = await params
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "venue-regular", authUser.userId))
    if (limited) return limited
    if (!isUuid(venueId)) return notFoundResponse("Venue not found")
    const parsed = putSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const result = await setRegularPrefs(authUser.userId, venueId, parsed.data)
    if ("refusal" in result) {
      if (result.refusal === "not_found") return notFoundResponse("Venue not found")
      if (result.refusal === "unclaimed") {
        return errorResponse("Nobody runs this place on Blendn yet, so there's nobody to tell.", 409, ErrorCode.VENUE_UNCLAIMED)
      }
      return errorResponse(`${ADULTS_ONLY} Add your date of birth to your profile first.`, 403, ErrorCode.AGE_RESTRICTED)
    }
    const res = await successResponse({ ...result.prefs })
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch (error) {
    logger.error("Set regular prefs failed", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to save your choice")
  }
}
