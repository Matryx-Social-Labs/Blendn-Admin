import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageEvent } from "@/lib/rbac"
import { emitChatMessage } from "@/lib/socket-server"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId } = await params

    const eventForGet = await db.events.findUnique({ where: { id: eventId }, select: { organizer_id: true } })
    if (!eventForGet) return new NextResponse("Not found", { status: 404 })
    if (!canManageEvent(session.user.role, session.user.id, eventForGet.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    const announcements = await db.event_announcements.findMany({
      where: { event_id: eventId },
      orderBy: { created_at: "desc" },
      take: 50,
      include: {
        sender: { select: { name: true, email: true } },
      },
    })

    return NextResponse.json(announcements)
  } catch (err) {
    console.error("Error fetching announcements:", err)
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function POST(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId } = await params

    const { content } = await req.json()
    if (!content?.trim()) {
      return new NextResponse("content is required", { status: 400 })
    }

    // Find the event's chat group (also used for access check)
    const event = await db.events.findUnique({
      where: { id: eventId },
      select: {
        organizer_id: true,
        chat_group: { select: { id: true } },
      },
    })

    if (!event) return new NextResponse("Event not found", { status: 404 })
    if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }
    if (!event.chat_group) {
      return new NextResponse("Event has no chatroom yet", { status: 422 })
    }

    const chatGroupId = event.chat_group.id

    // Persist announcement log entry
    const announcement = await db.event_announcements.create({
      data: {
        event_id: eventId,
        content: content.trim(),
        sent_by: session.user.id,
      },
      include: { sender: { select: { name: true, email: true } } },
    })

    // Persist as a chat message
    const chatMsg = await db.chat_messages.create({
      data: {
        chat_group_id: chatGroupId,
        user_id: session.user.id,
        type: "announcement",
        content: content.trim(),
        metadata: { announcement_id: announcement.id },
      },
    })

    await db.chat_groups.update({
      where: { id: chatGroupId },
      data: { last_message_at: chatMsg.created_at },
    })

    // Broadcast via Socket.io
    emitChatMessage(chatGroupId, {
      id: chatMsg.id,
      content: chatMsg.content,
      type: "announcement",
      userId: session.user.id,
      userName: session.user.name ?? "Organiser",
      createdAt: chatMsg.created_at.toISOString(),
    })

    return NextResponse.json(announcement, { status: 201 })
  } catch (err) {
    console.error("Error sending announcement:", err)
    return new NextResponse("Internal error", { status: 500 })
  }
}
