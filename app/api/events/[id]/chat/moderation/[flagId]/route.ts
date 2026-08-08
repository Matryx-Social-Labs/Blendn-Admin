import { logger } from "@/lib/logger"
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"

interface RouteParams {
  params: Promise<{ id: string; flagId: string }>
}

/**
 * PATCH /api/events/[id]/chat/moderation/[flagId]
 * Review a moderation flag: approve (restore message) or reject (keep hidden)
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAuth()
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id: eventId, flagId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: {
        id: true,
        organizer_org_id: true,
        venue: { select: { owner_org_id: true } },
        chat_group: { select: { id: true } },
      },
    })

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 })
    }

    if (!eventPermissions(await actorFor(session.user), event).canOperate) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body = await request.json()
    const { action, notes } = body as { action: "approve" | "reject"; notes?: string }

    if (!action || !["approve", "reject"].includes(action)) {
      return NextResponse.json(
        { error: "Invalid action. Must be 'approve' or 'reject'" },
        { status: 400 }
      )
    }

    /*
     * Scope the flag to this event's room, not just to the id.
     *
     * `canOperate` was checked against the event in the URL and the flag was
     * then loaded by id alone, so a host could pass their own `eventId` with
     * another organisation's `flagId` and approve -- un-hide -- a message in a
     * room they have no rights to. Reaching it needs a v4 UUID guess and the
     * listing endpoint is correctly scoped, so it was not practically
     * exploitable; the sibling message-delete route already carries this
     * predicate and there is no reason for this one not to.
     */
    const flag = await db.moderation_flags.findFirst({
      where: { id: flagId, chat_group_id: event.chat_group?.id },
      select: { id: true, message_id: true, status: true },
    })

    if (!flag) {
      return NextResponse.json({ error: "Flag not found" }, { status: 404 })
    }

    if (flag.status !== "pending") {
      return NextResponse.json(
        { error: "Flag has already been reviewed" },
        { status: 400 }
      )
    }

    if (action === "approve") {
      // Restore the message (false positive)
      await db.$transaction([
        db.moderation_flags.update({
          where: { id: flagId },
          data: {
            status: "approved",
            reviewed_by: session.user.id,
            reviewed_at: new Date(),
            review_notes: notes || null,
          },
        }),
        db.chat_messages.update({
          where: { id: flag.message_id },
          data: {
            moderation_status: "clean",
            deleted_at: null,
          },
        }),
      ])
    } else {
      // Reject — keep message hidden
      await db.moderation_flags.update({
        where: { id: flagId },
        data: {
          status: "rejected",
          reviewed_by: session.user.id,
          reviewed_at: new Date(),
          review_notes: notes || null,
        },
      })
    }

    return NextResponse.json({
      success: true,
      data: { flagId, action, reviewedBy: session.user.id },
    })
  } catch (error) {
    logger.error("Review moderation flag error", { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: "Failed to review flag" },
      { status: 500 }
    )
  }
}
