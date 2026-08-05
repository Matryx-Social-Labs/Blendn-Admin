import { logger } from "@/lib/logger"
import { NextRequest, NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { emitChatMemberBanned, emitChatMemberMuted } from "@/lib/socket-server"

interface RouteContext {
  params: Promise<{ id: string; userId: string }>
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId, userId: targetUserId } = await params
    const { action } = await request.json() as { action: "ban" | "unban" | "mute" | "unmute" }

    if (!["ban", "unban", "mute", "unmute"].includes(action)) {
      return new NextResponse("Invalid action. Must be ban, unban, mute, or unmute.", { status: 400 })
    }

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { organizer_org_id: true, venue: { select: { owner_org_id: true } }, chat_group: { select: { id: true } } },
    })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!eventPermissions(await actorFor(session.user), event).canOperate) {
      return new NextResponse("Forbidden", { status: 403 })
    }
    if (!event.chat_group) return new NextResponse("No chat group", { status: 404 })

    const statusMap = {
      ban: "banned" as const,
      unban: "active" as const,
      mute: "muted" as const,
      unmute: "active" as const,
    }

    await db.chat_group_members.update({
      where: {
        chat_group_id_user_id: {
          chat_group_id: event.chat_group.id,
          user_id: targetUserId,
        },
      },
      data: {
        status: statusMap[action],
        banned_at: action === "ban" ? new Date() : action === "unban" ? null : undefined,
        banned_by: action === "ban" ? session.user.id : action === "unban" ? null : undefined,
      },
    })

    if (action === "ban" || action === "unban") {
      emitChatMemberBanned(event.chat_group.id, targetUserId, action === "ban")
    }
    if (action === "mute" || action === "unmute") {
      emitChatMemberMuted(event.chat_group.id, targetUserId, action === "mute", "Muted by admin")
    }

    return NextResponse.json({ success: true, action, status: statusMap[action] })
  } catch (err) {
    logger.error("Ban member error", { error: err instanceof Error ? err.message : String(err) })
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
