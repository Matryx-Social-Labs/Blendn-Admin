import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse } from "@/lib/api-response"
import { refusalResponse } from "@/lib/crews/crews"
import { crewLinkPreview, NO_LINK } from "@/lib/crews/links"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit } from "@/lib/rate-limit"
import { shareNetworkFor } from "@/lib/share-public"

/**
 * Per visitor: there is no account to key on. www.blendn.app/c/<token> calls
 * this from Vercel and forwards the visitor, so the limit counts them, not
 * Vercel's address; a forwarded visitor without the landing's secret is
 * ignored (`shareNetworkFor`). The app's own call is keyed on its network.
 */
const PREVIEW_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyGenerator: (req: NextRequest) => `crew-link-preview:${shareNetworkFor(req.headers)}`,
}

/**
 * GET /api/mobile/crews/links/:token/preview — a crew link for somebody not
 * signed in yet: `{ name, emblemSeed, size, invitedBy: { name, photoUrl } }`.
 * No members, line or tags. A signed-in caller kept apart from anybody in the
 * crew gets the same 404 as a link that never existed.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const limited = await rateLimit(request, PREVIEW_LIMIT)
    if (limited) return limited

    const { token } = await params
    // Optional: a bad or expired token is treated as nobody, never as a 401.
    const viewer = await getAuthenticatedUser(request)
    const preview = await crewLinkPreview(token, viewer?.userId ?? null)
    return preview ? successResponse(preview) : refusalResponse(NO_LINK)
  } catch (error) {
    logger.error("Crew link preview error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to open the link")
  }
}
