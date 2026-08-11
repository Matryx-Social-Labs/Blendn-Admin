import { NextRequest } from "next/server"
import { z } from "zod"

import {
  forbiddenResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { datingAgeRefusal } from "@/lib/age"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

const preferencesSchema = z.object({
  intent: z.array(z.enum(["dating", "networking", "friendship", "just_here"])).max(4).optional(),
  revealed: z.boolean().optional(),

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

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "match-prefs", authUser.userId))
    if (limited) return limited

    const parsed = preferencesSchema.safeParse(await request.json())
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { intent, revealed, remember } = parsed.data
    // The deprecated flag means both, which is what it always did.
    const rememberIntent = parsed.data.rememberIntent ?? remember ?? false
    const rememberReveal = parsed.data.rememberReveal ?? remember ?? false

    const checkIn = await db.event_check_ins.findFirst({
      where: { event_id: eventId, user_id: authUser.userId },
      select: { id: true },
    })
    if (!checkIn) return forbiddenResponse("Check in to this event first")

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
        select: { age: true },
      })
      const refusal = datingAgeRefusal(intent, profile?.age)
      if (refusal) return forbiddenResponse(refusal)
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
      },
      update: {
        ...(intent !== undefined ? { intent } : {}),
        ...(revealed !== undefined ? { revealed } : {}),
        updated_at: new Date(),
      },
      select: { intent: true, revealed: true },
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
    if (revealed === true) {
      await Promise.all([
        db.private_conversations.updateMany({
          where: {
            origin_event_id: eventId,
            user1_id: authUser.userId,
            user1_revealed: false,
            closed_at: null,
          },
          data: { user1_revealed: true },
        }),
        db.private_conversations.updateMany({
          where: {
            origin_event_id: eventId,
            user2_id: authUser.userId,
            user2_revealed: false,
            closed_at: null,
          },
          data: { user2_revealed: true },
        }),
      ])
    }

    if (rememberIntent || rememberReveal) {
      await db.profiles.update({
        where: { id: authUser.userId },
        data: {
          ...(rememberIntent && intent !== undefined ? { intent_default: intent } : {}),
          ...(rememberReveal && revealed !== undefined ? { reveal_by_default: revealed } : {}),
        },
      })
    }

    return successResponse(updated)
  } catch (error) {
    logger.error("Match preferences error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to save preferences")
  }
}
