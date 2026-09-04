import { logger } from "@/lib/logger"
import { errorResponse } from "@/lib/api-response"
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
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { id: eventId, userId: targetUserId } = await params
    const { action } = await request.json() as { action: "ban" | "unban" | "mute" | "unmute" }

    if (!["ban", "unban", "mute", "unmute"].includes(action)) {
      return errorResponse("Invalid action. Must be ban, unban, mute, or unmute.", 400)
    }

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { organizer_org_id: true, venue: { select: { owner_org_id: true } }, chat_group: { select: { id: true } } },
    })
    if (!event) return errorResponse("Not found", 404)
    if (!eventPermissions(await actorFor(session.user), event).canOperate) {
      return errorResponse("Forbidden", 403)
    }
    if (!event.chat_group) return errorResponse("No chat group", 404)

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
        /*
         * Three outcomes per pair, and `undefined` was carrying one of them.
         *
         * ban   -> set the timestamp and the actor
         * unban -> null them, which is a real write and must not be skipped
         * mute/unmute -> leave the ban columns entirely alone
         *
         * As a spread the third case is an absent key rather than an undefined
         * value, which is what `strictUndefinedChecks` requires and what the
         * `??` idiom could not express.
         */
        ...(action === "ban"
          ? { banned_at: new Date(), banned_by: session.user.id }
          : action === "unban"
            ? { banned_at: null, banned_by: null }
            : {}),
        /*
         * A mute records who applied it, exactly as a ban does.
         *
         * `muted_by` was the missing half. `checkAndAutoUnmute` clears any
         * `muted` status from a member with fewer than three auto-hide flags in
         * the last hour, and an organiser-applied mute has **zero** -- so
         * `0 < 3` held and the mute lifted itself on the muted person's next
         * message. The moderator watched the action succeed and it undid itself.
         */
        ...(action === "mute"
          ? { muted_at: new Date(), muted_by: session.user.id }
          : action === "unmute"
            ? { muted_at: null, muted_by: null }
            : {}),
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
    return errorResponse("Internal Server Error", 500)
  }
}
