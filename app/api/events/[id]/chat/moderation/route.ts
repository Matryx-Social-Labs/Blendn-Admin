import { logger } from "@/lib/logger"
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/events/[id]/chat/moderation
 * List moderation flags for an event's chat group (paginated)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAuth()
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id: eventId } = await params

    // Get event with chat group
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: {
        id: true,
        organizer_org_id: true, venue: { select: { owner_org_id: true } },
        chat_group: { select: { id: true } },
      },
    })

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 })
    }

    if (!eventPermissions(await actorFor(session.user), event).canOperate) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    if (!event.chat_group) {
      return NextResponse.json({ error: "No chat group for this event" }, { status: 404 })
    }

    // Hosts get the pseudonym the room shows; only platform admins get the
    // person behind it. Same rule as `chat/messages`.
    const isPlatformAdmin = session.user.role === "app_admin"
    const anonByUser = new Map(
      (
        await db.chat_group_members.findMany({
          where: { chat_group_id: event.chat_group.id },
          select: { user_id: true, anonymous_name: true },
        })
      ).map((m) => [m.user_id, m.anonymous_name])
    )

    const searchParams = request.nextUrl.searchParams
    const status = searchParams.get("status") || "pending"
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"))
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "20")))

    const where = {
      chat_group_id: event.chat_group.id,
      ...(status !== "all" && { status: status as "pending" | "approved" | "rejected" }),
    }

    const [flags, total] = await Promise.all([
      db.moderation_flags.findMany({
        where,
        include: {
          message: {
            select: {
              id: true,
              content: true,
              type: true,
              created_at: true,
              deleted_at: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.moderation_flags.count({ where }),
    ])

    // Get summary stats
    const [pendingCount, hiddenCount, totalFlags] = await Promise.all([
      db.moderation_flags.count({
        where: { chat_group_id: event.chat_group.id, status: "pending" },
      }),
      db.moderation_flags.count({
        where: { chat_group_id: event.chat_group.id, auto_action: "hidden" },
      }),
      db.moderation_flags.count({
        where: { chat_group_id: event.chat_group.id },
      }),
    ])

    return NextResponse.json({
      success: true,
      data: {
        flags: flags.map((f) => ({
          id: f.id,
          messageId: f.message_id,
          userId: f.user_id,
          anonymousName: anonByUser.get(f.user_id) ?? null,
          /*
           * Admin-only, and absent rather than null for hosts so a client
           * reading `userName` gets undefined instead of a convincing blank.
           *
           * The sibling `chat/messages` route was fixed for exactly this and
           * this one was missed. `canOperate` is organiser and venue owner, not
           * admin, so any host could read the real name and email address of
           * every "anonymous" attendee who had ever been auto-flagged -- and
           * the pseudonym sits next to it on the adjacent Chat tab, keyed on
           * the same `userId`. The admin-only moderation CSV in `lib/reports.ts`
           * deliberately carries no user id at all, which is the clearest sign
           * this was an oversight rather than a decision.
           */
          ...(isPlatformAdmin ? { userName: f.user.name, userEmail: f.user.email } : {}),
          source: f.source,
          status: f.status,
          categories: f.categories,
          confidence: f.confidence,
          autoAction: f.auto_action,
          reviewedBy: f.reviewed_by,
          reviewedAt: f.reviewed_at,
          reviewNotes: f.review_notes,
          createdAt: f.created_at,
          message: {
            id: f.message.id,
            content: f.message.content,
            type: f.message.type,
            createdAt: f.message.created_at,
            isDeleted: !!f.message.deleted_at,
          },
        })),
        stats: {
          pending: pendingCount,
          autoHidden: hiddenCount,
          total: totalFlags,
        },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    })
  } catch (error) {
    logger.error("Get moderation flags error", { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: "Failed to get moderation flags" },
      { status: 500 }
    )
  }
}
