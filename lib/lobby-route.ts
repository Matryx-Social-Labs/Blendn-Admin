import type { NextRequest } from "next/server"

import { errorResponse, notFoundResponse, unauthorizedResponse } from "@/lib/api-response"
import { isUuid } from "@/lib/api-input"
import { boardRefusal, lobbyState, lobbyStateRefusal, mayReadBoard, type LobbyState } from "@/lib/board"
import { entitlementFor } from "@/lib/board-access"
import { db } from "@/lib/db"
import { attendeeEventAccess, eventAccessResponse } from "@/lib/event-access"
import { lobbyEventSelect, type LobbyEvent } from "@/lib/lobby"
import { getAuthenticatedUser } from "@/lib/mobile-auth"

/**
 * The door every Lobby read goes through (SCRUM-1026): signed in, the event
 * there and open to this person (`attendeeEventAccess`), the Lobby not closed,
 * and — unless `gate: "none"` — the caller saved it or said they are going
 * (`mayReadBoard`). One door, so the list, a post, the preview, the room's
 * card and the alerts cannot answer one person differently.
 */
export async function lobbyDoor(
  request: NextRequest,
  eventId: string,
  gate: "read" | "none" = "read"
): Promise<{ userId: string; event: LobbyEvent; state: Exclude<LobbyState, "closed">; mayRead: boolean } | Response> {
  const user = await getAuthenticatedUser(request)
  if (!user) return unauthorizedResponse("Authentication required")
  if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

  const denied = await attendeeEventAccess(user.userId, eventId, "participate")
  if (denied) return eventAccessResponse(denied)
  const event = await db.events.findUnique({ where: { id: eventId, deleted_at: null }, select: lobbyEventSelect })
  if (!event) return notFoundResponse("Event not found")

  const state = lobbyState(event)
  if (state === "closed") {
    const { message, reasonCode } = lobbyStateRefusal(state)
    return errorResponse(message, 403, undefined, reasonCode)
  }
  const mayRead = mayReadBoard(await entitlementFor(eventId, user.userId)) === null
  if (gate === "read" && !mayRead) {
    const { message, reasonCode } = boardRefusal("not_going", "read")
    return errorResponse(message, 403, undefined, reasonCode)
  }
  return { userId: user.userId, event, state, mayRead }
}
