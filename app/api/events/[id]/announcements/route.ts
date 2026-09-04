import { logger } from "@/lib/logger"
import { errorResponse } from "@/lib/api-response"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { roomAudience } from "@/lib/room-audience"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"
import { broadcastAuthorName, broadcastAuthorSelect } from "@/lib/broadcast-author"
import { actorFor } from "@/lib/org-membership"
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
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { id: eventId } = await params

    const eventForGet = await db.events.findUnique({ where: { id: eventId }, select: { organizer_org_id: true, venue: { select: { owner_org_id: true } } } })
    if (!eventForGet) return errorResponse("Not found", 404)
    if (!eventPermissions(await actorFor(session.user), eventForGet).canEdit) {
      return errorResponse("Forbidden", 403)
    }

    const announcements = await db.event_announcements.findMany({
      where: { event_id: eventId },
      orderBy: { created_at: "desc" },
      take: PAGINATION.DEFAULT_CHAT_LIMIT,
      include: {
        sender: { select: { name: true, email: true } },
      },
    })

    /*
     * The blast radius, returned alongside the history.
     *
     * The composer sent to every attendee with no indication of how many that
     * was — the most powerful and most abusable thing a host can do, behind a
     * textarea and one button. `reachable` is the number who will actually get
     * a phone notification, which is lower than `members` and is the figure
     * that matters.
     */
    const chatGroup = await db.chat_groups.findUnique({
      where: { event_id: eventId },
      select: { id: true },
    })

    /*
     * One definition of "the audience", shared with the sponsor report.
     *
     * This used to count members with `status: { not: "banned" }`. `left` is a
     * member_status, and the row is deliberately KEPT when somebody leaves
     * because `anonymous_name` lives on it — so the blast radius counted
     * everyone who had ever joined and grew all night as people left.
     *
     * `reachable` also fetched every push_token row into Node to call `.length`
     * on the array; `lib/room-audience.ts` groups in the database instead.
     */
    const audience = chatGroup
      ? await roomAudience(chatGroup.id)
      : { members: 0, reachable: 0 }

    return NextResponse.json({ announcements, audience })
  } catch (err) {
    logger.error("Error fetching announcements", { error: err instanceof Error ? err.message : String(err) })
    return errorResponse("Internal error", 500)
  }
}

export async function POST(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { id: eventId } = await params

    // An announcement pushes to every attendee of the event. Bound how fast a
    // single organiser account can fire them.
    const limited = await rateLimit(req as never, createUserRateLimit("organiser-broadcast", session.user.id))
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
        ...eventPermissionSelect,
        ...broadcastAuthorSelect,
        chat_group: { select: { id: true } },
      },
    })

    if (!event) return errorResponse("Event not found", 404)
    if (!eventPermissions(await actorFor(session.user), event).canEdit) {
      return errorResponse("Forbidden", 403)
    }
    if (!event.chat_group) {
      return errorResponse("Event has no chatroom yet", 422)
    }

    const chatGroupId = event.chat_group.id

    // Persist announcement log entry
    const announcement = await db.event_announcements.create({
      data: {
        event_id: eventId,
        content,
        sent_by: session.user.id,
      },
      include: { sender: { select: { name: true } } },
    })

    /*
     * The organisation, not the person. See `lib/broadcast-author.ts`.
     *
     * This was `session.user.name ?? session.user.email ?? "Organiser"`, so an
     * organiser with no display name **persisted their email address** into a
     * room where everybody else is a pseudonym. `sender.email` was being
     * selected and returned in the response too.
     */
    const senderName = broadcastAuthorName(event)
    const chatContent = `📢 [Announcement from ${senderName}]\n${content}`

    // Persist as a chat message
    const chatMsg = await db.chat_messages.create({
      data: {
        chat_group_id: chatGroupId,
        user_id: session.user.id,
        // See the mobile twin: `announcement` is the enum value that has always
        // existed and never been written. Text-only by rule, so the column
        // costs nothing to spend on the kind.
        type: "announcement",
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
      // The wire and the history agree on the kind, too. They already agree on
      // the author; a socket saying `text` for a row stored as `announcement`
      // is the same class of disagreement one line down.
      type: "announcement",
      userId: session.user.id,
      // The wire says the same thing the persisted content does. It said the
      // organiser's real name, so the socket disagreed with the history.
      userName: senderName,
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
    return errorResponse("Internal error", 500)
  }
}
