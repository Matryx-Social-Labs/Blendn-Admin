import { NextResponse } from "next/server"
import { z } from "zod"

import { errorResponse } from "@/lib/api-response"
import { isUuid, readJson } from "@/lib/api-input"
import { auditInTx, getRequestIp } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { lobbyState } from "@/lib/board"
import { BOARD } from "@/lib/constants"
import { db } from "@/lib/db"
import { hostPostFor, lobbyEventSelect } from "@/lib/lobby"
import { logger } from "@/lib/logger"
import { actorFor } from "@/lib/org-membership"
import { notifyLobbyHostPost } from "@/lib/push-notifications"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { eventPermissionSelect, eventPermissions } from "@/lib/rbac"
import { characters } from "@/lib/utils"

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * The host's pinned post in an event's Lobby (SCRUM-1026, owner decision 2).
 *
 * One per event. Written by anybody the event's organisation lets edit it
 * (`eventPermissions(...).canEdit`, organisation-shaped: a colleague has the
 * same access, a member who left loses it). Shown under the host's public
 * label (`broadcastAuthorName`), never the person who typed it, who is
 * recorded only in `written_by` and the audit log. Editable and unpinnable
 * until the Lobby closes, every change audited in its own transaction.
 *
 * Not moderated: it is the host speaking, as an announcement is, and the host
 * is accountable by name to us.
 */
async function hostDoor(eventId: string) {
  const session = await getAuth()
  if (!session?.user) return errorResponse("Unauthorized", 401)
  if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    // Hand-picked beside `lobbyEventSelect` (which has `kind` and `start_time`): the rest of `eventPermissionSelect`.
    select: { ...lobbyEventSelect, organizer_org_id: true, venue: eventPermissionSelect.venue },
  })
  if (!event) return errorResponse("Event not found", 404)
  if (!eventPermissions(await actorFor(session.user), event).canEdit) return errorResponse("Forbidden", 403)
  return { userId: session.user.id, event }
}

export async function GET(_: Request, { params }: RouteContext) {
  try {
    const door = await hostDoor((await params).id)
    if (door instanceof Response) return door
    return NextResponse.json({ pinned: await hostPostFor(door.event), state: lobbyState(door.event) })
  } catch (error) {
    logger.error("Lobby pin read error", { error: error instanceof Error ? error.message : String(error) })
    return errorResponse("Internal error", 500)
  }
}

const pinSchema = z.object({ body: z.string().trim().min(1, "Say something").max(BOARD.MAX_HOST_POST_LENGTH) }).strict()

export async function PUT(request: Request, { params }: RouteContext) {
  try {
    const door = await hostDoor((await params).id)
    if (door instanceof Response) return door
    const { userId, event } = door
    const limited = await rateLimit(request as never, userLimit("write", "lobby-pin", userId))
    if (limited) return limited
    if (lobbyState(event) === "closed") return errorResponse("The Lobby has closed", 409)

    const parsed = pinSchema.safeParse(await readJson(request))
    if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid request", 400)
    const { body } = parsed.data

    const { pin, changed } = await db.$transaction(async (tx) => {
      const before = await tx.board_host_posts.findUnique({ where: { event_id: event.id }, select: { body: true } })
      const pin = await tx.board_host_posts.upsert({
        where: { event_id: event.id },
        create: { event_id: event.id, body, written_by: userId },
        update: { body, written_by: userId, updated_at: new Date() },
        select: { id: true },
      })
      await auditInTx(tx, {
        userId,
        action: before ? "lobby.pin.edit" : "lobby.pin.set",
        resource: "event",
        resourceId: event.id,
        details: { hostPostId: pin.id, length: characters(body) },
        ipAddress: getRequestIp(request),
      })
      return { pin, changed: before?.body !== body }
    })

    if (changed) {
      void db.board_alert_preferences
        .findMany({ where: { event_id: event.id, host_posts: true }, select: { user_id: true } })
        .then((rows) => notifyLobbyHostPost(rows.map((r) => r.user_id), event, pin.id, body))
        .catch((error) => logger.warn("Lobby host post push failed", { eventId: event.id, error: String(error) }))
    }
    return NextResponse.json({ pinned: await hostPostFor(event) })
  } catch (error) {
    logger.error("Lobby pin write error", { error: error instanceof Error ? error.message : String(error) })
    return errorResponse("Internal error", 500)
  }
}

/** Unpin: the post goes; the audit log keeps that it was there. */
export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const door = await hostDoor((await params).id)
    if (door instanceof Response) return door
    const { userId, event } = door
    const limited = await rateLimit(request as never, userLimit("write", "lobby-pin", userId))
    if (limited) return limited

    const removed = await db.$transaction(async (tx) => {
      const gone = await tx.board_host_posts.deleteMany({ where: { event_id: event.id } })
      if (gone.count > 0) {
        await auditInTx(tx, { userId, action: "lobby.pin.clear", resource: "event", resourceId: event.id, ipAddress: getRequestIp(request) })
      }
      return gone.count > 0
    })
    return NextResponse.json({ pinned: null, removed })
  } catch (error) {
    logger.error("Lobby pin delete error", { error: error instanceof Error ? error.message : String(error) })
    return errorResponse("Internal error", 500)
  }
}
