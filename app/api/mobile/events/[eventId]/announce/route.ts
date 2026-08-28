import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { actorFor, resolveSponsorGrant } from "@/lib/org-membership"
import { broadcastAuthorName, broadcastAuthorSelect } from "@/lib/broadcast-author"
import {
  broadcastMayCarryMedia,
  canBroadcast,
  eventPermissionSelect,
  type BroadcastKind,
} from "@/lib/rbac"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { emitChatMessage } from "@/lib/socket-server"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const { eventId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("broadcast", "announce", authUser.userId))
    if (limited) return limited

    // Validate eventId is a valid UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(eventId)) {
      return errorResponse("Invalid event ID format", 400)
    }

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: {
        id: true,
        organizer_id: true,
        ...eventPermissionSelect,
        ...broadcastAuthorSelect,
        chat_group: {
          select: { id: true },
        },
      },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    const body = await request.json()
    const { content, kind: rawKind, mediaUrl, mediaType } = body as {
      content?: string
      kind?: string
      mediaUrl?: string
      mediaType?: string
    }

    const KINDS: readonly BroadcastKind[] = ["announcement", "sponsored", "system"]
    const kind: BroadcastKind = KINDS.includes(rawKind as BroadcastKind)
      ? (rawKind as BroadcastKind)
      : "announcement"

    /*
     * The resolver, not a comparison of two user ids.
     *
     * This route used to read `event.organizer_id !== authUser.userId`, which is
     * the same mistake `lib/rbac.ts` was written to end -- and it failed in
     * three directions at once: an app_admin could not announce, a venue owner
     * could not announce for an event in their own building, and a colleague at
     * the organising org was refused because they were not the row's creator.
     *
     * `organizer_id` still records who *created* the event. That is a different
     * question from who may act for it, and it stays useful for audit.
     */
    /*
     * The role comes from the database, not the token.
     *
     * `getAuthenticatedUser` returns `{ userId, email }` -- the mobile JWT
     * carries no role, and that is the right call: a 30-day refresh cycle means
     * a role baked into a token outlives the decision that changed it, so an
     * organiser demoted this morning would keep broadcasting until their token
     * expired. Reading it here costs one indexed lookup on a route that runs
     * once per announcement.
     */
    const sender = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { id: true, name: true, image: true, role: true },
    })
    if (!sender) return forbiddenResponse("You cannot broadcast to this event")

    const actor = await actorFor({ id: sender.id, role: sender.role })
    const grant = kind === "sponsored" ? await resolveSponsorGrant(actor, eventId) : null

    if (!canBroadcast(actor, event, kind, grant ?? undefined)) {
      /*
       * One message for all three refusals, deliberately.
       *
       * "Your organisation is not approved for sponsored messages" tells an
       * attacker probing the API which flag to go after, and tells an organiser
       * about a capability they cannot self-serve anyway.
       */
      return forbiddenResponse("You cannot broadcast to this event")
    }

    if (mediaUrl || mediaType) {
      /*
       * The event room is pseudonymous and a photograph is an identity -- of
       * whoever is in it, who is not always the person posting. Attendee media
       * is not built at all; an announcement is a host addressing that same
       * room, so it inherits the rule. Only sponsored artwork depicts nobody in
       * the room, which is what `broadcastMayCarryMedia` encodes.
       *
       * But nothing can PERSIST it. Neither `event_announcements` nor
       * `chat_messages` has a media column, so a URL accepted here would reach
       * only the sockets connected at that instant, vanish on reload, and be
       * invisible to moderation -- an image no moderator can review or delete.
       * Refusing is better than accepting and silently dropping.
       *
       * Sponsored media persists properly in the sponsor plan, on the creative
       * revision with checksum and version pinning. When that lands, restore
       * the `broadcastMayCarryMedia(kind)` branch here.
       */
      return errorResponse(
        broadcastMayCarryMedia(kind)
          ? "Media on sponsored messages is not available yet"
          : "Only sponsored messages may carry media",
        400
      )
    }

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return errorResponse("Announcement content is required", 400)
    }

    if (content.trim().length > 1000) {
      return errorResponse("Announcement content must be 1000 characters or fewer", 400)
    }

    const announcement = await db.event_announcements.create({
      data: {
        event_id: eventId,
        content: content.trim(),
        sent_by: authUser.userId,
      },
    })

    /*
     * The broadcast has to enter chat history, not just the wire.
     *
     * This route wrote `event_announcements` and emitted over the socket, and
     * stopped. The read path for a room is `chat_messages` only, so "Doors
     * close at 11" was visible exactly to whoever happened to be connected at
     * that second — anyone who backgrounded the app lost it, and it was gone on
     * reload. The dashboard twin has always written both.
     *
     * It also emitted the `event_announcements` id, which is a different row in
     * a different table from anything the client can act on: replies, reports
     * and moderator deletes against that id all missed their target. The
     * `chat_messages` id is emitted now.
     */
    /*
     * The organisation, not the person. See `lib/broadcast-author.ts`.
     *
     * This named the individual who typed it -- persisted into
     * `chat_messages.content`, in a room where every attendee is a pseudonym.
     * The dashboard twin was worse (it fell back to the email address), but
     * both put a real person's name into the pseudonymous room.
     */
    const author = broadcastAuthorName(event)
    const chatContent =
      kind === "announcement"
        ? `📢 [Announcement from ${author}]\n${content.trim()}`
        : content.trim()

    const chatMsg = event.chat_group?.id
      ? await db.chat_messages.create({
          data: {
            chat_group_id: event.chat_group.id,
            user_id: authUser.userId,
            /*
             * `announcement`, not `text` — the enum value has existed since the
             * schema was written and nothing had ever written it.
             *
             * The kind was carried only by the `📢 [Announcement from …]`
             * prefix on the content, which any attendee can type. On reload the
             * marker survived as a string and nothing structural said what this
             * message was, so the client could not style it, moderation could
             * not exclude it, and the sentiment sweeper counted it as room mood
             * (K3.1–K3.3, K3.7).
             *
             * Safe to move because `broadcastMayCarryMedia` is true only for
             * `sponsored`: an announcement is text by rule, so nothing is lost
             * by spending the column on the kind. That is NOT true of a
             * sponsored send — see the note in `lib/sponsored-scheduler.ts`.
             */
            type: "announcement",
            content: chatContent,
            metadata: { announcement_id: announcement.id },
          },
        })
      : null

    if (event.chat_group?.id && chatMsg) {
      await db.chat_groups.update({
        where: { id: event.chat_group.id },
        data: { last_message_at: chatMsg.created_at },
      })
    }

    // Emit announcement to event chat group via socket if one exists
    if (event.chat_group?.id && chatMsg) {
      emitChatMessage(event.chat_group.id, {
        id: chatMsg.id,
        content: chatContent,
        type: kind,
        userId: authUser.userId,
        /*
         * The sender's name, and only for the kinds that have one.
         *
         * `system` speaks as the platform: attaching a human name to it would
         * let a reader mistake an admin for Blend'n, or the reverse. The client
         * renders these three full-width with no avatar for the same reason --
         * a user message can never occupy that shape, so the label cannot be
         * forged by somebody choosing a convincing pseudonym.
         */
        userName: kind === "system" ? "Blend'n" : author,
        /*
         * No photograph either. A broadcast is the organisation speaking, and
         * this shipped the individual's avatar into the pseudonymous room
         * beside their name -- a face identifies as surely, which is the
         * argument this route already makes about attendee media forty lines up.
         */
        userImage: undefined,
        /*
         * Not emitted, deliberately.
         *
         * `broadcastMayCarryMedia` permits media on `sponsored`, but there is
         * no column anywhere to persist it: `event_announcements` has none and
         * `chat_messages` has none. So a media URL could only ever reach the
         * clients connected at that instant and would vanish on reload, which
         * is the same defect this commit fixes for text — and worse, because a
         * moderator could never review or delete an image that was never
         * stored.
         *
         * Sponsored media persists properly in the sponsor plan (media_url on
         * the creative revision, with checksum and version pinning). Until that
         * lands, accepting the field and dropping it is the honest behaviour;
         * pretending to broadcast it is not.
         */
        createdAt: chatMsg.created_at.toISOString(),
      })
    }

    // The chat_messages id, so replies, reports and moderator deletes address
    // a row that exists in the table the client actually reads.
    return successResponse({ id: chatMsg?.id ?? announcement.id })
  } catch (error) {
    logger.error("Send announcement error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send announcement")
  }
}
