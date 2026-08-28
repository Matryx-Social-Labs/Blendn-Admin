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

    const users = blocks.map((b) => ({
      blocked_id: b.blocked_id,
      // `null`, not a pseudonym: a pseudonym is per-event and this list is not
      // scoped to one. The client already renders a placeholder for an
      // unrevealed person.
      blocked_user_name: visible.has(b.blocked_id) ? b.blocked.name : null,
      blocked_user_photo: visible.has(b.blocked_id) ? b.blocked.image : null,
      reason: null,
      blocked_at: b.created_at.toISOString(),
    }))

    return successResponse({ users })
  } catch (error) {
    logger.error("Get blocked users error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to fetch blocked users")
  }
}
