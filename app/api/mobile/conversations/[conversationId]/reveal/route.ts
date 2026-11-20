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
  conflictResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { isUuid, readOptionalJson } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ conversationId: string }>
}

/**
 * Swap names: a mutual reveal (identity model, owner 2026-11-11).
 *
 * ```
 *   POST   /conversations/:id/reveal   → I tap Swap names
 *   DELETE /conversations/:id/reveal   → I take my tap back, while they have not tapped
 * ```
 *
 * `*_revealed` is each side's tap. Nothing shows until BOTH have tapped; then
 * both see each other's first name and photo, in this chat only
 * (`displayNameInConversation`, `mayShowRealName`). One tap alone names nobody.
 *
 * ## The tap is the ask
 *
 * There is no separate "ask them": my tap is what the other side sees as "they
 * want to swap" (`revealRequested`, `theyAskedToSwap`). It cannot nag -- a
 * second tap writes the same `true` and pushes nothing -- and there is no
 * decline: someone who does not want to swap simply does not.
 *
 * ## Taking it back
 *
 * Until they tap too, my tap is only an offer, so it can be withdrawn. Once
 * both have tapped the names are seen, and no flag can unsee them: the cancel
 * refuses (409). Both writes put the other side's state in their predicate, so
 * a cancel racing their tap is decided by the row, never by a stale read.
 */
const revealSchema = z.object({}).strict()

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

    const parsed = revealSchema.safeParse((await readOptionalJson(request)) ?? {})
    if (!parsed.success) return validationErrorResponse(parsed.error)

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
      where: { id: conversationId, [mine]: false, closed_at: null },
      data: isUser1 ? { user1_revealed: true } : { user2_revealed: true },
    })
    const after = await db.private_conversations.findUniqueOrThrow({
      where: { id: conversationId },
      select: { user1_revealed: true, user2_revealed: true },
    })
    const swapped = after.user1_revealed && after.user2_revealed

    const themId = isUser1 ? conversation.user2_id : conversation.user1_id
    if (count === 1) {
      // First tap: they are asked. Second: the names are swapped, and they are told.
      ;(swapped ? notifyReveal : notifyRevealRequest)(themId, conversationId).catch(() => {})
      // Their open DM re-reads now rather than on the next push they may never get.
      // Once both have tapped the same event goes to both: names, and the friend offer.
      emitPrivateRevealed(conversationId, swapped ? [authUser.userId, themId] : [themId])
    }
    // Both sides have swapped now: a friend request held for this pair is delivered.
    // Decided from the re-read after our UPDATE, not from the read before it:
    // two taps at once each read "the other has not", and only the second
    // UPDATE sees both. (The release itself announces only what it clears.)
    if (swapped) {
      await releaseHeldRequests([authUser.userId, themId]).catch((error) =>
        logger.warn("Releasing held friend requests failed", { error: error instanceof Error ? error.message : String(error) })
      )
    }

    // `mutual`: both have tapped, so each sees the other's first name and photo now.
    return successResponse({ revealed: true, mutual: swapped })
  } catch (error) {
    logger.error("Reveal error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to update reveal state")
  }
}

/** Take my Swap names tap back, while the other side has not tapped. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params
    if (!isUuid(conversationId)) return errorResponse("Invalid conversation ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "conversation-reveal", authUser.userId))
    if (limited) return limited

    const conversation = await db.private_conversations.findUnique({
      where: { id: conversationId },
      select: { user1_id: true, user2_id: true, user1_pseudonym: true, user2_pseudonym: true, closed_at: true },
    })
    if (!conversation || conversation.closed_at) return notFoundResponse("Conversation not found")
    const isUser1 = conversation.user1_id === authUser.userId
    if (!isUser1 && conversation.user2_id !== authUser.userId) {
      return forbiddenResponse("Not authorized for this conversation")
    }
    if (!conversation.user1_pseudonym && !conversation.user2_pseudonym) {
      return errorResponse("This conversation already shows real names", 400)
    }

    // Only my own tap, and only while theirs is still missing: a swap both made is kept.
    const [mine, theirs] = isUser1 ? (["user1_revealed", "user2_revealed"] as const) : (["user2_revealed", "user1_revealed"] as const)
    const { count } = await db.private_conversations.updateMany({
      where: { id: conversationId, closed_at: null, [mine]: true, [theirs]: false },
      data: { [mine]: false },
    })
    if (count === 0) {
      const now = await db.private_conversations.findUniqueOrThrow({
        where: { id: conversationId },
        select: { [mine]: true, [theirs]: true },
      })
      if (now[mine] && now[theirs]) return conflictResponse("You have already swapped names")
      // Nothing to take back: already not tapped. Answered as done, so a repeat is harmless.
      return successResponse({ revealed: false })
    }
    // Their open DM stops showing "they want to swap".
    emitPrivateRevealed(conversationId, [isUser1 ? conversation.user2_id : conversation.user1_id])
    return successResponse({ revealed: false })
  } catch (error) {
    logger.error("Reveal cancel error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to update reveal state")
  }
}
