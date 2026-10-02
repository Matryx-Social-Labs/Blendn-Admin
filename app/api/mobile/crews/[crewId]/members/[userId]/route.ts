import { NextRequest } from "next/server"
import { z } from "zod"

import { isUuid, readJson } from "@/lib/api-input"
import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { isRefusal, refusalResponse, removeFromCrew, setKeepMeAnonymous } from "@/lib/crews/crews"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { roomMemberFromRef } from "@/lib/room-handle"

interface RouteParams {
  params: Promise<{ crewId: string; userId: string }>
}

/**
 * The member a ref names in this crew: yourself by your own id, anybody else
 * only by the handle the crew's room showed you (`GET /crews/:id`). A raw id,
 * another room's handle or a forged one names nobody.
 */
async function memberFromRef(crewId: string, ref: string, viewerId: string): Promise<string | null> {
  if (ref === viewerId) return viewerId
  const room = await db.chat_groups.findUnique({ where: { crew_id: crewId }, select: { id: true } })
  return room ? roomMemberFromRef({ kind: "crew", groupId: room.id }, ref, viewerId) : null
}

const settingsSchema = z.object({ keepMeAnonymous: z.boolean() }).strict()

/**
 * PATCH /api/mobile/crews/:crewId/members/:userId — my own settings in the
 * crew (`userId` is my id): "keep me anonymous even when my crew reveals".
 * From now on: a crew reveal already made is not undone (D-10).
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-settings", authUser.userId))
    if (limited) return limited

    const { crewId, userId } = await params
    if (!isUuid(crewId) || userId !== authUser.userId) return notFoundResponse("Crew not found")
    const parsed = settingsSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    if (!(await setKeepMeAnonymous(authUser.userId, crewId, parsed.data.keepMeAnonymous))) {
      return notFoundResponse("Crew not found")
    }
    return successResponse({ keepMeAnonymous: parsed.data.keepMeAnonymous })
  } catch (error) {
    logger.error("Crew settings error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to save")
  }
}

/**
 * DELETE /api/mobile/crews/:crewId/members/:userId — leave the crew (my own
 * id), or, as its owner, remove a member (their handle in the crew's room).
 * A crew left with one person dissolves (D-15): `dissolved: true`.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-leave", authUser.userId))
    if (limited) return limited

    const { crewId, userId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const memberId = await memberFromRef(crewId, userId, authUser.userId)
    if (!memberId) return notFoundResponse("Crew not found")

    const result = await removeFromCrew(authUser.userId, crewId, memberId)
    if (isRefusal(result)) return refusalResponse(result)
    return successResponse(result)
  } catch (error) {
    logger.error("Crew leave error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to leave the crew")
  }
}
