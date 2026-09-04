import { logger } from "@/lib/logger"
import { errorResponse } from "@/lib/api-response"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { emitChatMessageDeleted } from "@/lib/socket-server"

interface RouteContext {
  params: Promise<{ id: string; messageId: string }>
}

export async function DELETE(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { id: eventId, messageId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { organizer_org_id: true, venue: { select: { owner_org_id: true } }, chat_group: { select: { id: true } } },
    })
    if (!event) return errorResponse("Not found", 404)
    if (!eventPermissions(await actorFor(session.user), event).canOperate) {
      return errorResponse("Forbidden", 403)
    }
    if (!event.chat_group) return errorResponse("No chat group", 404)

    const message = await db.chat_messages.findFirst({
      where: { id: messageId, chat_group_id: event.chat_group.id, deleted_at: null },
    })
    if (!message) return errorResponse("Message not found", 404)

    await db.chat_messages.update({
      where: { id: messageId },
      data: { deleted_at: new Date(), deleted_by: session.user.id },
    })

    emitChatMessageDeleted(event.chat_group.id, messageId)

    return NextResponse.json({ success: true })
  } catch (err) {
    logger.error("Delete message error", { error: err instanceof Error ? err.message : String(err) })
    return errorResponse("Internal Server Error", 500)
  }
}
