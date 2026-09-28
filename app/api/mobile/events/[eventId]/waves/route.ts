import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import {
  ErrorCode,
  errorResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { blockedEitherWay, pairIsClosed } from "@/lib/conversations"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { hit } from "@/lib/rate-limit-store"
import { emitRoomWave } from "@/lib/socket-server"
import { userIdFromRef } from "@/lib/room-handle"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

// User ids are cuid, not uuid — do not tighten this to z.string().uuid(). And
// the roster sends room handles (`rh_…`, SCRUM-371), which are neither.
const waveSchema = z.object({ toUserId: z.string().min(1) })

/** One wave per sender → recipient, per this long. */
const WAVE_WINDOW_MS = 10 * 60 * 1000

/**
 * Wave at somebody in the room.
 *
 * The lightest thing the Room offers: lighter than a like (which is recorded
 * and can open a conversation) and nothing like a message (which is stored,
 * moderated and pushed). A wave is a live socket event and nothing else — no
 * row, no push, no history — so if the recipient does not have the app open,
 * it simply did not happen, and that is the right failure for a gesture that
 * means "I see you, right now".
 *
 * Both of you have to be inside NOW (`status: checked_in`), not merely to have
 * attended, because "now" is the whole meaning. Somebody hidden from the roster
 * — "show online status" off, or suspended — is not a person you can see in the
 * room, so they are answered exactly as if they were not here.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    // The per-account ceiling across every recipient; the per-pair window is
    // below, once we know the wave is one that could be delivered.
    const limited = await rateLimit(request, userLimit("write", "event-wave", authUser.userId))
    if (limited) return limited

    const parsed = waveSchema.safeParse(await request.json())
    if (!parsed.success) return validationErrorResponse(parsed.error)
    // Resolved here, so everything below — the pair window's key included —
    // is on real ids: a new room is a new handle, not a new window.
    const toUserId = userIdFromRef(parsed.data.toUserId)
    const fromUserId = authUser.userId

    if (toUserId === fromUserId) {
      return errorResponse("You cannot wave at yourself", 400, ErrorCode.VALIDATION_FAILED)
    }

    const [mine, theirs] = await Promise.all([
      db.event_check_ins.findFirst({
        where: { event_id: eventId, user_id: fromUserId, status: "checked_in" },
        select: { id: true },
      }),
      db.event_check_ins.findFirst({
        where: {
          event_id: eventId,
          user_id: toUserId,
          status: "checked_in",
          // The roster's visibility rule, so you can only wave at someone the
          // roster would show you. `is: null` as there: a missing profile row
          // must not read as "show online" off.
          user: {
            suspended_at: null,
            OR: [{ profile: { is: null } }, { profile: { show_online: true } }],
          },
        },
        select: { id: true },
      }),
    ])

    if (!mine) {
      return errorResponse("Check in to wave at people here", 403, ErrorCode.NOT_CHECKED_IN)
    }

    /*
     * Not here, blocked either way, and unmatched all read the same.
     *
     * The likes route makes the same choice for the same reason: a distinct
     * answer for a block is a way to discover who blocked you, and one for a
     * closed pair is a rejection notice by another name. Unmatching is
     * permanent (`lib/conversations.ts`), and a wave from somebody who left the
     * conversation is exactly the contact leaving was meant to end.
     */
    const notHere = () =>
      errorResponse("They're not in the room right now", 403, ErrorCode.RECIPIENT_NOT_HERE)
    if (!theirs) return notHere()
    if (await blockedEitherWay(fromUserId, toUserId)) return notHere()
    if (await pairIsClosed(fromUserId, toUserId)) return notHere()

    /*
     * One wave per pair per ten minutes, in the shared rate-limit store (Redis
     * when configured, so it holds across instances).
     *
     * Counted only now, after every refusal above, so a wave that could not
     * have been delivered does not start the clock. Keyed on the pair and not
     * the event: moving to another room is not a reason to wave again at the
     * same person a minute later.
     */
    const { count, resetAt } = await hit(`rl:wave:${fromUserId}:${toUserId}`, WAVE_WINDOW_MS)
    if (count > 1) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
      return NextResponse.json(
        {
          success: false,
          error: "You waved at them a moment ago",
          errorCode: ErrorCode.WAVE_TOO_SOON,
          retryAfter,
        },
        { status: 429, headers: { "Retry-After": retryAfter.toString() } }
      )
    }

    emitRoomWave(toUserId, { eventId, fromUserId, fromName: await roomNameOf(eventId, fromUserId) })

    return successResponse({ sent: true })
  } catch (error) {
    logger.error("Wave error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to wave")
  }
}

/**
 * The sender as the room sees them — the roster's rule, verbatim.
 *
 * Real name only for somebody who chose "show who I am" in THIS event
 * (`event_match_preferences.revealed`); otherwise their pseudonym here. Falls
 * back to "Attendee", never to the real name: a missing pseudonym is a bug,
 * and degrading to the thing we are hiding turns the bug into a disclosure.
 */
async function roomNameOf(eventId: string, userId: string): Promise<string> {
  const [member, pref] = await Promise.all([
    db.chat_group_members.findFirst({
      where: { chat_group: { event_id: eventId }, user_id: userId },
      select: { anonymous_name: true },
    }),
    db.event_match_preferences.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
      select: { revealed: true },
    }),
  ])
  if (pref?.revealed) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } })
    const name = user?.name?.trim()
    if (name) return name
  }
  return member?.anonymous_name || "Attendee"
}
