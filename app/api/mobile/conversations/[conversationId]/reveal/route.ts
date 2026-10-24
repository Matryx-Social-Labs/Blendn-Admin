import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { notifyReveal, notifyRevealRequest } from "@/lib/push-notifications"
import { releaseHeldRequests } from "@/lib/friends"
import { emitPrivateRevealed } from "@/lib/private-revealed"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { isUuid, readOptionalJson } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ conversationId: string }>
}

/**
 * Showing someone who you are, or asking them to.
 *
 * ```
 *   POST /conversations/:id/reveal          → my side becomes visible to them
 *   POST /conversations/:id/reveal { ask }  → I ask them to show me
 * ```
 *
 * ## Per side, and one way
 *
 * `user1_revealed` and `user2_revealed` move independently. Revealing is a
 * standing offer, not a trade: going first must not expose the other person,
 * and waiting must not be treated as a refusal.
 *
 * It is also **not retractable**. Once a name and a face have been seen a flag
 * cannot unsee them, and a control implying otherwise would be worse than its
 * absence. The client says so before the tap; this route simply has no path
 * back to `false`.
 *
 * ## Asking, and the rejection that never arrives
 *
 * A request is one boolean on the side being asked. Two properties fall out of
 * that shape, and both are wanted:
 *
 * - **It cannot nag.** Asking twice writes the same `true`. There is no counter
 *   to increment and no second notification to send.
 * - **There is no decline.** Not unimplemented — deliberately absent. A decline
 *   delivers a rejection, and this product exists to remove exactly that:
 *   *"you never approach someone who hasn't already said yes."* Someone who does
 *   not want to reveal simply does not, and the asker sees "reveal requested"
 *   rather than "reveal refused". Silence is the softest possible no.
 *
 * You cannot ask someone who is already revealed — there is nothing left to
 * ask for. That is the asymmetric case: if you were public in the room where you
 * matched, they already saw your card, so your side starts `true` and only
 * theirs is pending.
 */
const revealSchema = z.object({
  /** Ask the other person to reveal, instead of revealing yourself. */
  ask: z.boolean().optional(),
})

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params
    if (!isUuid(conversationId)) return errorResponse("Invalid conversation ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(
      request,
      userLimit("write", "conversation-reveal", authUser.userId)
    )
    if (limited) return limited

    const parsed = revealSchema.safeParse(await readOptionalJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { ask } = parsed.data

    const conversation = await db.private_conversations.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        user1_id: true,
        user2_id: true,
        user1_revealed: true,
        user2_revealed: true,
        user1_pseudonym: true,
        user2_pseudonym: true,
        closed_at: true,
      },
    })
    if (!conversation) return notFoundResponse("Conversation not found")
    // Closed is gone for both people, so there is nobody to reveal to.
    if (conversation.closed_at) return notFoundResponse("Conversation not found")

    const isUser1 = conversation.user1_id === authUser.userId
    const isUser2 = conversation.user2_id === authUser.userId
    if (!isUser1 && !isUser2) {
      return forbiddenResponse("Not authorized for this conversation")
    }

    // A conversation that was never pseudonymous has nothing to reveal — an
    // accepted message request has shown real names since it existed.
    if (!conversation.user1_pseudonym && !conversation.user2_pseudonym) {
      return errorResponse("This conversation already shows real names", 400)
    }

    if (ask) {
      const theirSideRevealed = isUser1
        ? conversation.user2_revealed
        : conversation.user1_revealed
      if (theirSideRevealed) {
        // Nothing left to ask for. Refused at the endpoint rather than merely
        // hidden in the UI, so the rule is enforced rather than rendered.
        return errorResponse("They have already revealed", 400)
      }

      // Only the call that flips the flag notifies: a repeat is a no-op, not
      // another push at someone who cannot decline (API M4).
      const { count } = await db.private_conversations.updateMany({
        where: { id: conversationId, ...(isUser1 ? { user2_reveal_requested: false } : { user1_reveal_requested: false }) },
        data: isUser1 ? { user2_reveal_requested: true } : { user1_reveal_requested: true },
      })

      const themId = isUser1 ? conversation.user2_id : conversation.user1_id
      if (count === 1) notifyRevealRequest(themId, conversationId).catch(() => {})

      return successResponse({ requested: true })
    }

    /*
     * Revealing shows a name and a photo. With neither, the switch turns on and
     * the other person's screen is byte-for-byte what it was — so they conclude
     * the feature is broken rather than that the profile is empty.
     *
     * A capability gate for one action, not a completeness meter: it names the
     * one missing input at the moment somebody reaches for the one feature that
     * needs it. `docs/PLACEHOLDER_SCREENS.md` bans profile-strength framing and
     * this does not reintroduce it.
     */
    const profile = await db.profiles.findUnique({
      where: { id: authUser.userId },
      select: { name: true, photos: true },
    })

    const hasName = Boolean(profile?.name?.trim())
    const hasPhoto = Boolean(profile?.photos?.length)
    if (!hasName || !hasPhoto) {
      const missing =
        !hasName && !hasPhoto ? "a name and a photo" : !hasPhoto ? "a photo" : "a name"
      // The message is the copy — it drops straight into the prompt, which is
      // why `missing` is phrased to complete that sentence rather than being a
      // machine token the client has to translate.
      return errorResponse(`Add ${missing} to your profile first`, 400, "reveal_incomplete")
    }

    // The flip is the claim: only the call whose UPDATE changes the row tells
    // anybody, so a repeat (or a parallel pair) pushes once (API M4).
    const mine = isUser1 ? "user1_revealed" : "user2_revealed"
    const { count } = await db.private_conversations.updateMany({
      where: { id: conversationId, [mine]: false },
      data: { [mine]: true },
    })
    const after = await db.private_conversations.findUniqueOrThrow({
      where: { id: conversationId },
      select: { user1_revealed: true, user2_revealed: true },
    })

    const themId = isUser1 ? conversation.user2_id : conversation.user1_id
    if (count === 1) {
      notifyReveal(themId, conversationId).catch(() => {})
      // Their open DM re-reads now rather than on the next push they may never get.
      // Once both have revealed the same event goes to both: the friend offer is possible.
      emitPrivateRevealed(
        conversationId,
        after.user1_revealed && after.user2_revealed ? [authUser.userId, themId] : [themId]
      )
    }
    // Both sides have shown themselves now: a friend request held for this pair is delivered.
    // Decided from the values the UPDATE returned, not from the read before it:
    // two reveals at once each read "the other has not", and only the second
    // UPDATE sees both. (The release itself announces only what it clears.)
    if (after.user1_revealed && after.user2_revealed) {
      await releaseHeldRequests([authUser.userId, themId]).catch((error) =>
        logger.warn("Releasing held friend requests failed", { error: error instanceof Error ? error.message : String(error) })
      )
    }

    return successResponse({
      revealed: true,
      // Whether they have revealed too. Not a precondition for anything — each
      // side stands alone — but the client needs it to render the header.
      mutual: isUser1 ? conversation.user2_revealed : conversation.user1_revealed,
    })
  } catch (error) {
    logger.error("Reveal error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to update reveal state")
  }
}
