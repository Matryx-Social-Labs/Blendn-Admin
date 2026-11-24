import { NextRequest } from "next/server"
import { z } from "zod"

import { getAuth } from "@/lib/auth"
import { readJson } from "@/lib/api-input"
import { errorResponse, serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { httpsUrl } from "@/lib/https-url"
import { logger } from "@/lib/logger"
import { checkClip, clipCheckOn } from "@/lib/media-clip"
import { rateLimit, userLimit } from "@/lib/rate-limit"

const bodySchema = z.object({ url: httpsUrl() })

/** In the editor's words: nothing here says the clip is bad, so the save goes on without a check. */
const UNAVAILABLE = "We couldn’t check this clip right now. You can save it, and check it again later."

/**
 * Checks a clip an organizer added: its length, size, stills and copies
 * (SCRUM-1106). 422 is a verdict on the clip; 503 is not.
 */
export async function POST(request: NextRequest) {
  try {
    if (!clipCheckOn()) return errorResponse(UNAVAILABLE, 503)

    const session = await getAuth()
    if (!session?.user) return unauthorizedResponse("Authentication required")
    // The roles that may upload an event's media (`/api/uploads/presigned-url`).
    const { role } = session.user
    if (role !== "app_admin" && role !== "organizer" && role !== "venue_owner") {
      return errorResponse("Not authorized to check clips", 403)
    }

    const limited = await rateLimit(request, userLimit("clipCheck", "clip-check", session.user.id))
    if (limited) return limited

    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const result = await checkClip(parsed.data.url, session.user.id)
    if (result.kind === "refused") return errorResponse(result.message, 422, "CLIP_REFUSED")
    if (result.kind === "unavailable") return errorResponse(UNAVAILABLE, 503)
    return successResponse(result.clip)
  } catch (error) {
    logger.error("Clip check error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to check the clip")
  }
}
