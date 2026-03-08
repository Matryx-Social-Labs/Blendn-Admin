import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canModerateChat } from "@/lib/rbac"
import { emitChatMessageDeleted } from "@/lib/socket-server"

interface RouteContext {
  params: Promise<{ id: string; messageId: string }>
}

export async function DELETE(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId, messageId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { organizer_id: true, chat_group: { select: { id: true } } },
    })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canModerateChat(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }
    if (!event.chat_group) return new NextResponse("No chat group", { status: 404 })

    const message = await db.chat_messages.findFirst({
      where: { id: messageId, chat_group_id: event.chat_group.id, deleted_at: null },
    })
    if (!message) return new NextResponse("Message not found", { status: 404 })

    await db.chat_messages.update({
      where: { id: messageId },
      data: { deleted_at: new Date(), deleted_by: session.user.id },
    })

    emitChatMessageDeleted(event.chat_group.id, messageId)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Delete message error:", err)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
