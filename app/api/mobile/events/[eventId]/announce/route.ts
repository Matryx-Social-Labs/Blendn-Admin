import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { actorFor, maySponsorFor } from "@/lib/org-membership"
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
    const maySponsor = kind === "sponsored" ? await maySponsorFor(actor) : false

    if (!canBroadcast(actor, event, kind, maySponsor)) {
      /*
       * One message for all three refusals, deliberately.
       *
       * "Your organisation is not approved for sponsored messages" tells an
       * attacker probing the API which flag to go after, and tells an organiser
       * about a capability they cannot self-serve anyway.
       */
      return forbiddenResponse("You cannot broadcast to this event")
    }

    if ((mediaUrl || mediaType) && !broadcastMayCarryMedia(kind)) {
      /*
       * The event room is pseudonymous and a photograph is an identity -- of
       * whoever is in it, who is not always the person posting. Attendee media
       * is not built at all; an announcement is a host addressing that same
       * room, so it inherits the rule. Only sponsored artwork depicts nobody in
       * the room.
       */
      return errorResponse("Only sponsored messages may carry media", 400)
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

    // Emit announcement to event chat group via socket if one exists
    if (event.chat_group?.id) {
      emitChatMessage(event.chat_group.id, {
        id: announcement.id,
        content: content.trim(),
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
        userName: kind === "system" ? "Blend'n" : (sender.name ?? "Organiser"),
        userImage: kind === "system" ? undefined : (sender.image ?? undefined),
        ...(mediaUrl && broadcastMayCarryMedia(kind) ? { mediaUrl, mediaType } : {}),
        createdAt: announcement.created_at.toISOString(),
      })
    }

    return successResponse({ id: announcement.id })
  } catch (error) {
    logger.error("Send announcement error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send announcement")
  }
}
