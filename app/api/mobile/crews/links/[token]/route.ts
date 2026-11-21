import { NextRequest } from "next/server"

import { readJson } from "@/lib/api-input"
import { serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { isRefusal, joinCrewSchema, refusalResponse } from "@/lib/crews/crews"
import { crewLinkFor, joinByLink, NO_LINK } from "@/lib/crews/links"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ token: string }>
}

/**
 * GET /api/mobile/crews/links/:token — the invite card for a crew link (S7):
 * `{ crewId, name, emblemSeed, size, invitedBy: { name, photoUrl }, bio, tags,
 * expiresAt, member }`. Every way a link can fail is the one 404
 * (`INVITE_UNAVAILABLE`, lib/crews/links.ts).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-link-open", authUser.userId))
    if (limited) return limited

    const { token } = await params
    const card = await crewLinkFor(authUser.userId, token)
    return card ? successResponse(card) : refusalResponse(NO_LINK)
  } catch (error) {
    logger.error("Open crew link error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to open the link")
  }
}

/**
 * POST /api/mobile/crews/links/:token — join by the link, `{ revealConsent:
 * true, keepMeAnonymous? }` as the invite's join. Makes you and the sharer
 * friends in the same transaction. `{ crewId, chatGroupId }`; 404 for every
 * way the link cannot be used, 409 when the crew is full or you are in enough
 * crews (the link is not spent), 403 under 18 or not set up.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-join", authUser.userId))
    if (limited) return limited

    const parsed = joinCrewSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { token } = await params
    const joined = await joinByLink(authUser.userId, token, parsed.data)
    return isRefusal(joined) ? refusalResponse(joined) : successResponse(joined)
  } catch (error) {
    logger.error("Crew link join error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to join the crew")
  }
}
