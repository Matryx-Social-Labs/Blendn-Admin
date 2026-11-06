import { NextRequest } from "next/server"
import { z } from "zod"

import { serverErrorResponse, successResponse, validationErrorResponse } from "@/lib/api-response"
import { readJson } from "@/lib/api-input"
import { db } from "@/lib/db"
import { alertPrefsFor } from "@/lib/lobby"
import { lobbyDoor } from "@/lib/lobby-route"
import { logger } from "@/lib/logger"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/*
 * The Lobby's alerts for one event (SCRUM-1026, owner decision 4): three
 * switches, all off until turned on. They gate the push only; the bell row of
 * an ask or a yes is written either way.
 *
 *   offersMatch  somebody offers what you are looking for   board_match
 *   replies      an ask on your post, or a yes to yours      board_request, board_request_accepted
 *   hostPosts    the host's pinned post goes up or changes   board_host_post
 */

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    const door = await lobbyDoor(request, eventId)
    if (door instanceof Response) return door
    return successResponse(await alertPrefsFor(door.userId, eventId))
  } catch (error) {
    logger.error("Lobby alerts read error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load your alerts")
  }
}

const alertsSchema = z
  .object({ offersMatch: z.boolean().optional(), replies: z.boolean().optional(), hostPosts: z.boolean().optional() })
  .strict()

/** Any of the three; the ones left out keep their value. */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    const door = await lobbyDoor(request, eventId)
    if (door instanceof Response) return door
    const limited = await rateLimit(request, userLimit("write", "lobby-alerts", door.userId))
    if (limited) return limited

    const parsed = alertsSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const set = {
      ...(parsed.data.offersMatch !== undefined && { offers_match: parsed.data.offersMatch }),
      ...(parsed.data.replies !== undefined && { replies: parsed.data.replies }),
      ...(parsed.data.hostPosts !== undefined && { host_posts: parsed.data.hostPosts }),
    }
    await db.board_alert_preferences.upsert({
      where: { user_id_event_id: { user_id: door.userId, event_id: eventId } },
      create: { user_id: door.userId, event_id: eventId, ...set },
      update: { ...set, updated_at: new Date() },
    })
    return successResponse(await alertPrefsFor(door.userId, eventId))
  } catch (error) {
    logger.error("Lobby alerts write error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to save your alerts")
  }
}
