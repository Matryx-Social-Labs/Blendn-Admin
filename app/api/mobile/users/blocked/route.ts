import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { maySeeIdentityFor } from "@/lib/identity"
import { successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"

// GET /api/mobile/users/blocked — List users blocked by the current user
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const blocks = await db.blocked_users.findMany({
      where: { blocker_id: authUser.userId },
      orderBy: { created_at: "desc" },
      include: {
        blocked: {
          select: { id: true, name: true, image: true },
        },
      },
    })

    /*
     * Two endpoints, one pair of people, opposite answers.
     *
     * `GET /users/:id` returns 404 for somebody you have blocked. This one
     * returned their real name and their photograph, to the same caller, in the
     * same session -- so blocking somebody was a way to *keep* their identity
     * after the gate that guards it had closed.
     *
     * Worse in one direction than it looks: block is the documented way to undo
     * a reveal. Someone you had revealed to could block you and the list would
     * still hold your face indefinitely.
     *
     * The list still has a job -- you need to see who you have blocked in order
     * to unblock them -- so it keeps whatever it may legitimately show. That is
     * the same `maySeeIdentity` the profile route asks, and for a blocked pair
     * it is false unless the block is one-directional and something else in the
     * rule still holds.
     */
    /*
     * Asked once for the whole list, not once per person.
     *
     * This was `blocks.map((b) => maySeeIdentity(...))`, and the singular gate
     * runs five queries — so a list of twenty blocked people cost a hundred.
     * It reads as correct in review, which is the point: a singular gate on a
     * surface that is always a list invites exactly this, and every surface
     * that resolves identity here is a list.
     */
    const visible = await maySeeIdentityFor(
      authUser.userId,
      blocks.map((b) => b.blocked_id)
    )

    /*
     * The name you knew them by.
     *
     * With the identity gate closed for every blocked pair, this list rendered
     * "Unknown user" for each row — driven on iOS after blocking from a
     * thread — so someone with three blocks could not tell which was which,
     * and the one job the list has (unblocking) needed a guess. The most
     * recent conversation between the pair knows what the blocker saw: the
     * pseudonym snapshot if it was pseudonymous, the real name if it never was
     * (an accepted request showed it). Neither is new information; it is
     * exactly what the block was a reaction to. No conversation, no name.
     */
    const ids = blocks.map((b) => b.blocked_id)
    const conversations = ids.length
      ? await db.private_conversations.findMany({
          where: {
            OR: [
              { user1_id: authUser.userId, user2_id: { in: ids } },
              { user2_id: authUser.userId, user1_id: { in: ids } },
            ],
          },
          orderBy: { created_at: "desc" },
          select: { user1_id: true, user2_id: true, user1_pseudonym: true, user2_pseudonym: true },
        })
      : []
    // `null` in the map means "a conversation that showed the real name".
    const knownAs = new Map<string, string | null>()
    for (const c of conversations) {
      const theirs = c.user1_id === authUser.userId ? c.user2_id : c.user1_id
      if (knownAs.has(theirs)) continue // newest first
      const pseudonym = c.user1_id === theirs ? c.user1_pseudonym : c.user2_pseudonym
      const wasPseudonymous = c.user1_pseudonym !== null || c.user2_pseudonym !== null
      knownAs.set(theirs, wasPseudonymous ? pseudonym : null)
    }

    const users = blocks.map((b) => {
      const name = visible.has(b.blocked_id)
        ? b.blocked.name
        : knownAs.has(b.blocked_id)
          ? (knownAs.get(b.blocked_id) ?? b.blocked.name)
          : null
      return {
        blocked_id: b.blocked_id,
        blocked_user_name: name,
        blocked_user_photo: visible.has(b.blocked_id) ? b.blocked.image : null,
        reason: null,
        blocked_at: b.created_at.toISOString(),
      }
    })

    return successResponse({ users })
  } catch (error) {
    logger.error("Get blocked users error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to fetch blocked users")
  }
}
