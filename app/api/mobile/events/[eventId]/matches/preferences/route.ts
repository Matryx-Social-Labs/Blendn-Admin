import { NextRequest } from "next/server"
import { roomBanRefusal } from "@/lib/room-ban"
import { z } from "zod"

import {
  forbiddenResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  ErrorCode,
} from "@/lib/api-response"
import { ageFrom, datingAgeRefusal } from "@/lib/age"
import { db } from "@/lib/db"
import { inRoomWhere } from "@/lib/event-kind"
import { intentArray } from "@/lib/validations/profile"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { readJson, isUuid } from "@/lib/api-input"
import { revealConversationsFrom } from "@/lib/matches"
import { lensForEvent, WORK_LENS, type RoomLens } from "@/lib/tonight"
import { screenUserText, textNotAllowedResponse } from "@/lib/moderation/user-text"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/** `varchar(140)`, counted as Postgres counts it: characters (code points), not UTF-16 units. */
const TONIGHT_ANSWER_MAX = 140

/**
 * Their answer to tonight's question: one line on a card, so whitespace runs
 * (newlines included) collapse to one space. Empty after that is "no answer".
 * The outer `max` only bounds the work done on hostile input.
 */
const tonightAnswerSchema = z
  .string()
  .max(TONIGHT_ANSWER_MAX * 8)
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .refine((s) => [...s].length <= TONIGHT_ANSWER_MAX, { message: `Keep it to ${TONIGHT_ANSWER_MAX} characters` })
  .nullable()

const preferencesSchema = z.object({
  // Same rule as `intent_default`, from the same place. The per-event screen
  // already enforced exclusivity client-side; this is what makes it true.
  intent: intentArray.optional(),
  revealed: z.boolean().optional(),
  /**
   * "Open to joining a crew tonight" (plan v2 §8.3): without it a person here
   * alone is never shown crews, and no crew can like them. Per event, off
   * until they say so.
   */
  openToCrews: z.boolean().optional(),
  /** Tonight's question, answered (`room_lenses`, lib/tonight.ts). `null` or blank clears it. */
  tonightAnswer: tonightAnswerSchema.optional(),
  /** Why you are here, at a work-lens event only ("Here to hire"). One pick; `null` clears it. */
  workIntent: z.enum(["hire", "find_work", "build", "learn"]).nullable().optional(),

  /*
   * Two remembers, because one of them was writing something it never said.
   *
   * `remember` set **both** `intent_default` and `reveal_by_default`, and the
   * app renders that switch underneath the reveal toggle, labelled "Do this at
   * future events too". So somebody agreeing to be named at future work meetups
   * silently overwrote their person-level intent as well — a field they had set
   * on a different screen, for a different reason, and were given no indication
   * had changed.
   */
  rememberIntent: z.boolean().optional(),
  rememberReveal: z.boolean().optional(),

  /**
   * @deprecated Accepted so the shipped build keeps working; means both.
   *
   * Removable once no installed version sends it, which is not the same day
   * this ships — an app in the store is a client you cannot upgrade.
   */
  remember: z.boolean().optional(),
})

type CheckIn = { id: string; occurrence: { end_time: Date } }

/** Their check-in in this room, or the refusal: banned by the host, or not in it. */
async function roomCheckIn(eventId: string, userId: string): Promise<{ checkIn: CheckIn } | { refusal: Response }> {
  // A host's ban closes the room's people as it closes its chat (`roomBanRefusal`).
  const banned = await roomBanRefusal(eventId, userId)
  if (banned) return { refusal: banned }
  const checkIn = await db.event_check_ins.findFirst({
    where: { event_id: eventId, user_id: userId, ...inRoomWhere(userId) },
    select: { id: true, occurrence: { select: { end_time: true } } },
    orderBy: { check_in_time: "desc" },
  })
  return checkIn ? { checkIn } : { refusal: forbiddenResponse("Check in to this event first") }
}

function preferencesBody(
  row: {
    intent: string[]
    revealed: boolean
    open_to_crews_until: Date | null
    tonight_answer: string | null
    work_intent: string | null
  } | null,
  lens: RoomLens | null
) {
  return {
    intent: row?.intent ?? [],
    revealed: row?.revealed ?? false,
    openToCrews: !!row?.open_to_crews_until && row.open_to_crews_until > new Date(),
    tonightAnswer: row?.tonight_answer ?? null,
    workIntent: row?.work_intent ?? null,
    /** The room's lens: what leads on a card here, and the question it asks (null: none). Null when nothing maps. */
    lens,
  }
}

const preferencesSelect = { intent: true, revealed: true, open_to_crews_until: true, tonight_answer: true, work_intent: true } as const

/**
 * Your own answers for this room, and its lens -- what Room settings shows.
 * Only yours: this route reads nobody else's row. In the room only, as PUT.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "match-prefs", authUser.userId))
    if (limited) return limited

    const inRoom = await roomCheckIn(eventId, authUser.userId)
    if ("refusal" in inRoom) return inRoom.refusal
    const [row, lens] = await Promise.all([
      db.event_match_preferences.findUnique({
        where: { event_id_user_id: { event_id: eventId, user_id: authUser.userId } },
        select: preferencesSelect,
      }),
      lensForEvent(eventId),
    ])
    return successResponse(preferencesBody(row, lens))
  } catch (error) {
    logger.error("Read match preferences error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load preferences")
  }
}

/**
 * Why you are here tonight, and whether you want to be named.
 *
 * Per event, because both genuinely change: someone open to dating at a Friday
 * party is often only there for the talk on Tuesday. Asking once at signup and
 * never again would get one of those wrong every time.
 *
 * `rememberIntent` and `rememberReveal` each write the matching profile default.
 * Without one of them this is a one-night answer.
 *
 * Reveal defaults to false everywhere and is **never** flipped on implicitly —
 * the room is pseudonymous, and being named has to be something a person did in
 * that room rather than something that happened to them. `reveal_by_default` is
 * a suggestion the app offers after check-in, applied by a tap; check-in itself
 * always creates `revealed: false`.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "match-prefs", authUser.userId))
    if (limited) return limited

    const parsed = preferencesSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { intent, revealed, openToCrews, remember, workIntent } = parsed.data
    // Blank is "no answer": stored as null, never as "".
    const tonightAnswer = parsed.data.tonightAnswer === undefined ? undefined : parsed.data.tonightAnswer || null
    // The deprecated flag means both, which is what it always did.
    const rememberIntent = parsed.data.rememberIntent ?? remember ?? false
    const rememberReveal = parsed.data.rememberReveal ?? remember ?? false

    const inRoom = await roomCheckIn(eventId, authUser.userId)
    if ("refusal" in inRoom) return inRoom.refusal
    const { checkIn } = inRoom
    /*
     * "Open to joining a crew tonight" means tonight: it lasts until the end of
     * the occurrence they are checked in at, and lapses by itself — the row is
     * per event, and a multi-day event's Tuesday answer is not Wednesday's.
     */
    const openToCrewsUntil = openToCrews === undefined ? undefined : openToCrews ? checkIn.occurrence.end_time : null

    /*
     * The other place dating intent can be written, and the reason the rule
     * lives in `lib/age.ts` rather than in the profile route.
     *
     * A gate on one of two write paths is not a gate. This one is the more
     * likely bypass of the two: it is per-event, it is the path the app's
     * check-in flow uses, and `remember: true` writes the profile default
     * through it — so without this, the profile check could be walked straight
     * around by setting the same value from inside a room.
     */
    if (intent !== undefined) {
      const profile = await db.profiles.findUnique({
        where: { id: authUser.userId },
        select: { age: true, date_of_birth: true },
      })
      // Derived — see `ageFrom` in lib/age.ts. Dating is 18+, and a stored age
      // means someone who joined at 17 stays locked out after they turn 18.
      const refusal = datingAgeRefusal(intent, ageFrom(profile))
      if (refusal) return forbiddenResponse(refusal)
    }

    /*
     * Tonight's answer: only to a question the room asks (a venue night asks
     * none), and held to the room's chat rule -- it is read by the same people
     * as a chat line, under the same pseudonym. Clearing is always allowed.
     */
    const lens = await lensForEvent(eventId)
    if (tonightAnswer) {
      if (!lens?.question) return errorResponse("This room has no question tonight", 400, ErrorCode.VALIDATION_FAILED)
      const refused = screenUserText(authUser.userId, "tonight_answer", { tonightAnswer })
      if (refused) return textNotAllowedResponse(refused.field, "That can’t go in your answer.")
    }
    // Why you are here: the work lens's card only. Clearing is always allowed.
    if (workIntent && lens?.key !== WORK_LENS) {
      return errorResponse("This room does not ask why you are here", 400, ErrorCode.VALIDATION_FAILED)
    }

    /*
     * One row per person per event — not per check-in.
     *
     * This used to update the check-in row that `findFirst` happened to return.
     * On a five-day conference that is one of five rows, chosen with no
     * ordering, so writing your intent on Wednesday could land on Monday's row
     * and reading it back could return Tuesday's. The unique key on
     * `(event_id, user_id)` makes there be one answer to write.
     */
    const updated = await db.event_match_preferences.upsert({
      where: { event_id_user_id: { event_id: eventId, user_id: authUser.userId } },
      create: {
        event_id: eventId,
        user_id: authUser.userId,
        intent: intent ?? [],
        revealed: revealed ?? false,
        open_to_crews_until: openToCrewsUntil ?? null,
        tonight_answer: tonightAnswer ?? null,
        work_intent: workIntent ?? null,
      },
      update: {
        ...(intent !== undefined ? { intent } : {}),
        ...(revealed !== undefined ? { revealed } : {}),
        ...(openToCrewsUntil !== undefined ? { open_to_crews_until: openToCrewsUntil } : {}),
        ...(tonightAnswer !== undefined ? { tonight_answer: tonightAnswer } : {}),
        ...(workIntent !== undefined ? { work_intent: workIntent } : {}),
        updated_at: new Date(),
      },
      select: preferencesSelect,
    })

    /*
     * Going public in the room carries into the DMs you already have from it.
     *
     * Somebody who reveals mid-event has shown their name and face on the match
     * card to everyone there — including people they already matched with. A DM
     * still calling them "Wandering Kestrel" after that is not protecting
     * anything; it is just two screens disagreeing.
     *
     * Monotonic, and only in this direction. Un-revealing in the room does NOT
     * re-anonymise a conversation: nothing can unsee a face, and a control that
     * implied otherwise would be a lie. `revealed: false` in the filter is what
     * makes it monotonic — an already-revealed side is left alone.
     */
    if (revealed === true) await revealConversationsFrom(eventId, [authUser.userId])

    if (rememberIntent || rememberReveal) {
      await db.profiles.update({
        where: { id: authUser.userId },
        data: {
          ...(rememberIntent && intent !== undefined ? { intent_default: intent } : {}),
          ...(rememberReveal && revealed !== undefined ? { reveal_by_default: revealed } : {}),
        },
      })
    }

    return successResponse(preferencesBody(updated, lens))
  } catch (error) {
    logger.error("Match preferences error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to save preferences")
  }
}
