import { NextRequest, NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canModerateChat } from "@/lib/rbac"
import { emitChatMemberBanned } from "@/lib/socket-server"

interface RouteContext {
  params: Promise<{ id: string; userId: string }>
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId, userId: targetUserId } = await params
    const { action } = await request.json() as { action: "ban" | "unban" }

    if (action !== "ban" && action !== "unban") {
      return new NextResponse("Invalid action", { status: 400 })
    }

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { organizer_id: true, chat_group: { select: { id: true } } },
    })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canModerateChat(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }
    if (!event.chat_group) return new NextResponse("No chat group", { status: 404 })

    const banned = action === "ban"

    await db.chat_group_members.update({
      where: {
        chat_group_id_user_id: {
          chat_group_id: event.chat_group.id,
          user_id: targetUserId,
        },
      },
      data: {
        status: banned ? "banned" : "active",
        banned_at: banned ? new Date() : null,
        banned_by: banned ? session.user.id : null,
      },
    })

    emitChatMemberBanned(event.chat_group.id, targetUserId, banned)

    return NextResponse.json({ success: true, banned })
  } catch (err) {
    console.error("Ban member error:", err)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
