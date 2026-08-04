import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageEvent } from "@/lib/rbac"
import { rateLimit, createUserRateLimit } from "@/lib/rate-limit"
import { announcementSchema } from "@/lib/validations/event"
import { emitChatMessage } from "@/lib/socket-server"
import { notifyAnnouncement } from "@/lib/push-notifications"
import { PAGINATION } from "@/lib/constants"

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
      take: PAGINATION.DEFAULT_CHAT_LIMIT,
      include: {
        sender: { select: { name: true, email: true } },
      },
    })

    return NextResponse.json(announcements)
  } catch (err) {
    logger.error("Error fetching announcements", { error: err instanceof Error ? err.message : String(err) })
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function POST(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId } = await params

    // An announcement pushes to every attendee of the event. Bound how fast a
    // single organiser account can fire them.
    const limited = rateLimit(req as never, createUserRateLimit("organiser-broadcast", session.user.id))
    if (limited) return limited

    const parsed = announcementSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }
    const { content } = parsed.data

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
        content,
        sent_by: session.user.id,
      },
      include: { sender: { select: { name: true, email: true } } },
    })

    const senderName = session.user.name ?? session.user.email ?? "Organiser"
    const chatContent = `📢 [Announcement from ${senderName}]\n${content}`

    // Persist as a chat message
    const chatMsg = await db.chat_messages.create({
      data: {
        chat_group_id: chatGroupId,
        user_id: session.user.id,
        type: "text",
        content: chatContent,
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
      type: "text",
      userId: session.user.id,
      userName: session.user.name ?? "Organiser",
      createdAt: chatMsg.created_at.toISOString(),
    })

    // Fetch event title then send push notifications (fire and forget)
    db.events.findUnique({ where: { id: eventId }, select: { title: true } })
      .then((ev) => {
        if (!ev) return
        void notifyAnnouncement(
          chatGroupId,
          ev.title,
          content,
          eventId,
          session.user.id
        )
      })
      .catch((err) => logger.error("Failed to send announcement push notifications", { error: err instanceof Error ? err.message : String(err) }))

    return NextResponse.json(announcement, { status: 201 })
  } catch (err) {
    logger.error("Error sending announcement", { error: err instanceof Error ? err.message : String(err) })
    return new NextResponse("Internal error", { status: 500 })
  }
}
