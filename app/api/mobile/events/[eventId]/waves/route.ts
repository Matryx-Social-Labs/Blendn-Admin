import { NextRequest, NextResponse } from "next/server"
import { firstName } from "@/lib/conversation-identity"
import { roomBanRefusal } from "@/lib/room-ban"
import { eventRoomBan } from "@/lib/room-kind"
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
import { inRoomWhere } from "@/lib/event-kind"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { hit } from "@/lib/rate-limit-store"
import { emitRoomWave } from "@/lib/socket-server"
import { roomMemberFromRef } from "@/lib/room-handle"
import { knownToEachOther, LISTED_IN_ROSTER } from "@/lib/room-people"
import { openIfMutual } from "@/lib/matches"
import { announceRoomMatch } from "@/lib/room-match"
import { operatesEvent } from "@/lib/tonight"
import { hasVisibleWaveFrom, hasWaved, receivedWaves, recordWave, roomIsOpen, waveCapFor, type WaveCap } from "@/lib/waves"
import { roomPseudonymOf } from "@/lib/anonymous-names"
import { visibleInRoom } from "@/lib/identity"
import { readJson, isUuid } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

// User ids are cuid, not uuid — do not tighten this to z.string().uuid(). And
// the roster sends room handles (`rh_…`, SCRUM-371), which are neither.
const waveSchema = z.object({ toUserId: z.string().min(1) })

/** The live ping across rooms (W2): one per pair per this long, whichever room. A wave back is never held by it. */
const WAVE_WINDOW_MS = 10 * 60 * 1000

/** The roster's visibility rule for the person waved at: listed, not suspended, a guest and not staff (SCRUM-891). */
const waveable = { kind: "attendee" as const, user: { suspended_at: null, ...LISTED_IN_ROSTER } }

/**
 * Wave at somebody in the room. Recorded (SCRUM-1042, owner ruling 2026-11-12:
 * Wave replaces Like for people).
 *
 * - **One per pair per room**, never re-sent (W1). A second tap is answered as
 *   the first was, `sent: true`, with no row and no ping.
 * - **A new wave needs both of you inside now** (`checked_in`): "now" is what
 *   a wave means. **A wave back** answers a wave you were sent, and may be
 *   sent until the room closes even if either of you has left (approval 10).
 *   A like is not a wave you were sent: it never opens that door, so leaving
 *   and waving cannot test for one.
 * - **Mutual**: two waves (or a wave and an old like, approval 11) open the
 *   anonymous conversation through the like-match path (`openIfMutual`), and
 *   only the earlier one gets a push.
 * - **The sender caps** (W3-W6) are read BEFORE anything about the recipient
 *   (W8), so a 429 says nothing about who they are, whether they are here or
 *   whether they blocked you.
 * - **Not here, blocked either way, banned, unmatched, a friend, a host** all
 *   read the same 403 `RECIPIENT_NOT_HERE`: a distinct answer is a way to
 *   learn who blocked you, and one for a closed pair is a rejection notice.
 *   For a sender who has left, all of those AND "nobody waved at you" read as
 *   the one 403 `NOT_CHECKED_IN`.
 *
 * The socket ping (`room:wave`) is the live half; the received list
 * (`GET` here, `GET /waves` for Banter) is the half that survives the
 * recipient not looking. There is no push for a single wave (P-A).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    // The burst ceiling across every recipient; the stored caps are below.
    const limited = await rateLimit(request, userLimit("write", "event-wave", authUser.userId))
    if (limited) return limited

    const parsed = waveSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    /*
     * Only a handle this room showed you — or your own id, refused just below.
     * A raw id, another room's handle or a forged one is nobody here, and is
     * answered exactly as somebody not in the room (`roomMemberFromRef`).
     */
    // A host's ban closes the room's people as it closes its chat (`roomBanRefusal`).
    const banned = await roomBanRefusal(eventId, authUser.userId)
    if (banned) return banned
    const toUserId = roomMemberFromRef(eventId, parsed.data.toUserId, authUser.userId)
    const fromUserId = authUser.userId

    if (toUserId === fromUserId) {
      return errorResponse("You cannot wave at yourself", 400, ErrorCode.VALIDATION_FAILED)
    }

    // Everything about the sender first: in this room as a guest, and not somebody who runs it.
    const notCheckedIn = () => errorResponse("Check in to wave at people here", 403, ErrorCode.NOT_CHECKED_IN)
    const [attended, insideNow, open, hosts] = await Promise.all([
      db.event_check_ins.findFirst({
        where: { event_id: eventId, user_id: fromUserId, check_in_time: { not: null } },
        orderBy: { check_in_time: "desc" },
        select: { kind: true },
      }),
      db.event_check_ins.findFirst({
        // At a venue day, a window still open (`inRoomWhere`), not the sweeper's lag.
        where: { event_id: eventId, user_id: fromUserId, kind: "attendee", status: "checked_in", ...inRoomWhere(fromUserId) },
        select: { id: true },
      }),
      roomIsOpen(eventId),
      operatesEvent(fromUserId, eventId),
    ])
    // Your latest row decides: staff are working (SCRUM-891). Hosts never wave.
    if (!attended || attended.kind === "staff" || !open || hosts) return notCheckedIn()

    const capped = await waveCapFor(fromUserId, eventId)
    if (capped) return capResponse(capped)

    /*
     * Inside now, a refused recipient is "not here". Left, EVERY refusal from
     * here on is the one "check in" answer, byte for byte -- never waved at
     * you, hidden, blocked either way, banned, a friend, a host -- so leaving
     * and waving cannot ask who waved at you (security review, MEDIUM).
     */
    const notHere = () =>
      insideNow
        ? errorResponse("They’re not in the room right now", 403, ErrorCode.RECIPIENT_NOT_HERE)
        : notCheckedIn()
    if (!toUserId) return notHere()

    // A wave back: a wave from them that YOUR list shows (`hasVisibleWaveFrom`), so it reads nothing you were not shown.
    const answering = await hasVisibleWaveFrom(fromUserId, eventId, toUserId)
    if (!answering && !insideNow) return notHere()

    const theirs = await db.event_check_ins.findFirst({
      where: answering
        ? // Answering lasts until the room closes, so attendance, not presence.
          { event_id: eventId, user_id: toUserId, check_in_time: { not: null }, ...waveable }
        : { event_id: eventId, user_id: toUserId, status: "checked_in", ...inRoomWhere(), ...waveable },
      select: { id: true },
    })
    if (!theirs) return notHere()
    // Banned from the room is not in it: the same answer, never which.
    if (await eventRoomBan(eventId, toUserId)) return notHere()
    if (await blockedEitherWay(fromUserId, toUserId)) return notHere()
    if (await pairIsClosed(fromUserId, toUserId)) return notHere()
    // A friend is never a stranger to wave at (lib/room-people.ts).
    if (await knownToEachOther(fromUserId, toUserId)) return notHere()
    // Nobody waves at a host either.
    if (await operatesEvent(toUserId, eventId)) return notHere()

    // Already waved here: the same answer as the first time, and nothing else (W1).
    if (await hasWaved(eventId, fromUserId, toUserId)) return successResponse({ sent: true, mutual: false })

    /*
     * The live ping's pair window (W2), counted only now, after every refusal,
     * so a wave that could not have been delivered does not start the clock.
     * Keyed on the people, not the room. Not for a wave back: an answer is
     * never held because you waved at them in another room a minute ago.
     */
    if (!answering) {
      const { count, resetAt } = await hit(`rl:wave:${fromUserId}:${toUserId}`, WAVE_WINDOW_MS)
      if (count > 1) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
        return NextResponse.json(
          { success: false, error: "You waved at them a moment ago", errorCode: ErrorCode.WAVE_TOO_SOON, retryAfter },
          { status: 429, headers: { "Retry-After": retryAfter.toString() } }
        )
      }
    }

    const stored = await recordWave(eventId, fromUserId, toUserId)
    if (!stored.recorded) {
      // Two taps at once: the other one stored it. Capped only in that same race.
      return stored.capped ? capResponse(stored.capped) : successResponse({ sent: true, mutual: false })
    }

    const outcome = await openIfMutual(eventId, fromUserId, toUserId)
    if (outcome.mutual && outcome.conversationId) {
      // `room:match` to both, in place of the ping: the moment is "You both waved". Never rejects.
      await announceRoomMatch(eventId, outcome.conversationId)
    } else {
      emitRoomWave(toUserId, { eventId, fromUserId, fromName: await roomNameOf(eventId, fromUserId, toUserId) })
    }

    return successResponse({ sent: true, ...outcome })
  } catch (error) {
    logger.error("Wave error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to wave")
  }
}

/**
 * Who waved at you in this room (S-A, "See all"): newest first, paged 20,
 * by room handle and the roster's name, never an id. Readable while the room
 * is open, by a guest who was in it. A host reads nothing here.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("read", "event-waves-read", authUser.userId))
    if (limited) return limited

    const banned = await roomBanRefusal(eventId, authUser.userId)
    if (banned) return banned

    const viewerId = authUser.userId
    const [attended, hosts, open] = await Promise.all([
      db.event_check_ins.findFirst({
        where: { event_id: eventId, user_id: viewerId, check_in_time: { not: null } },
        orderBy: { check_in_time: "desc" },
        select: { kind: true },
      }),
      operatesEvent(viewerId, eventId),
      roomIsOpen(eventId),
    ])
    if (!attended || attended.kind === "staff" || hosts) {
      return errorResponse("Check in to see who waved", 403, ErrorCode.NOT_CHECKED_IN)
    }
    // The room closed: nothing left to answer.
    if (!open) return successResponse({ open: false, total: 0, waves: [], nextCursor: null })

    const page = await receivedWaves(viewerId, eventId, { cursor: request.nextUrl.searchParams.get("cursor") })
    if ("refused" in page) return errorResponse("Invalid cursor", 400, ErrorCode.VALIDATION_FAILED)
    return successResponse({ open: true, ...page })
  } catch (error) {
    logger.error("Wave list error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load waves")
  }
}

/** A sender cap (W3-W6): about the sender only, never the person they waved at. */
function capResponse(cap: WaveCap): NextResponse {
  const error = cap.cap === "day" ? "You’ve waved a lot today. Try again later." : "You’ve waved a lot in this room. Try again in a bit."
  return NextResponse.json(
    { success: false, error, errorCode: ErrorCode.RATE_LIMITED, retryAfter: cap.retryAfter },
    { status: 429, headers: { "Retry-After": cap.retryAfter.toString() } }
  )
}

/**
 * The sender as the recipient sees them on the roster — the roster's rule,
 * verbatim (`visibleInRoom`).
 *
 * Real name only for somebody the recipient may recognise in THIS room: they
 * chose "show who I am" here, or they are the recipient's friend and let
 * friends recognise them in rooms. Otherwise their pseudonym here. Falls back
 * to "Attendee", never to the real name: a missing pseudonym is a bug, and
 * degrading to the thing we are hiding turns the bug into a disclosure.
 */
async function roomNameOf(eventId: string, fromUserId: string, toUserId: string): Promise<string> {
  const [pseudonym, visible] = await Promise.all([
    roomPseudonymOf(eventId, fromUserId),
    visibleInRoom(toUserId, eventId, [fromUserId]),
  ])
  if (visible.has(fromUserId)) {
    const user = await db.user.findUnique({ where: { id: fromUserId }, select: { name: true } })
    const name = user?.name?.trim()
    if (name) return firstName(name)
  }
  return pseudonym
}
