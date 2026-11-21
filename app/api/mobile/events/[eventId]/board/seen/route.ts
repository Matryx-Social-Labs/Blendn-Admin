import { NextRequest } from "next/server"
import { z } from "zod"

import { serverErrorResponse, successResponse, validationErrorResponse } from "@/lib/api-response"
import { readOptionalJson } from "@/lib/api-input"
import { db } from "@/lib/db"
import { lobbyDoor } from "@/lib/lobby-route"
import { logger } from "@/lib/logger"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

const seenSchema = z.object({ at: z.string().datetime({ offset: true }).optional() }).strict()

/**
 * "I have seen this Lobby up to here" (SCRUM-1095, ROADMAP Going 6): the Lobby screen sends the newest post's
 * `createdAt` on the page it showed (the server's clock), and Going's rows count the posts after it
 * (`lobby.newCount` on `GET /me/rsvps`), on any phone. No `at` means now; a time in the future is now. The marker
 * only moves forward, so a late or out-of-order call never brings old posts back as new.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    const door = await lobbyDoor(request, eventId)
    if (door instanceof Response) return door
    const limited = await rateLimit(request, userLimit("write", "lobby-seen", door.userId))
    if (limited) return limited

    const parsed = seenSchema.safeParse(await readOptionalJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const now = new Date()
    const asked = parsed.data.at ? new Date(parsed.data.at) : now
    const at = asked > now ? now : asked

    const [row] = await db.$queryRaw<{ seen_at: Date }[]>`
      INSERT INTO board_seen (user_id, event_id, seen_at) VALUES (${door.userId}, ${eventId}::uuid, ${at})
      ON CONFLICT (user_id, event_id) DO UPDATE SET seen_at = GREATEST(board_seen.seen_at, EXCLUDED.seen_at)
      RETURNING seen_at`
    return successResponse({ seenAt: row.seen_at })
  } catch (error) {
    logger.error("Lobby seen write error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to save where you got to in the Lobby")
  }
}
