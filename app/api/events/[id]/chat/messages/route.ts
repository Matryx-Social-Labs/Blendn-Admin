import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canModerateChat } from "@/lib/rbac"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { organizer_id: true, chat_group: { select: { id: true } } },
    })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canModerateChat(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }
    if (!event.chat_group) return NextResponse.json({ messages: [] })

    const messages = await db.chat_messages.findMany({
      where: { chat_group_id: event.chat_group.id, deleted_at: null },
      orderBy: { created_at: "desc" },
      take: 100,
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    })

    // Also fetch member anonymous names
    const members = await db.chat_group_members.findMany({
      where: { chat_group_id: event.chat_group.id },
      select: { user_id: true, anonymous_name: true, status: true, banned_at: true },
    })
    const memberMap = new Map(members.map((m) => [m.user_id, m]))

    return NextResponse.json({
      chatGroupId: event.chat_group.id,
      messages: messages.reverse().map((m) => ({
        id: m.id,
        content: m.content,
        type: m.type,
        createdAt: m.created_at.toISOString(),
        user: {
          id: m.user.id,
          name: m.user.name,
          email: m.user.email,
          image: m.user.image,
          anonymousName: memberMap.get(m.user.id)?.anonymous_name ?? null,
        },
      })),
      members: members.map((m) => ({
        userId: m.user_id,
        anonymousName: m.anonymous_name,
        status: m.status,
        bannedAt: m.banned_at?.toISOString() ?? null,
      })),
    })
  } catch (err) {
    console.error("Chat messages fetch error:", err)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
