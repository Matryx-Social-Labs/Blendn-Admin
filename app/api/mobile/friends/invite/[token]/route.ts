import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { participationRefusal } from "@/lib/event-access"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { INVITE_TOKEN, friendState, mayConnect, personCard, personSelect } from "@/lib/friends"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"

/**
 * GET /api/mobile/friends/invite/:token — who sent this link, and where you
 * stand with them.
 *
 * Shows the owner's name and photo: they handed the link out, which is the
 * consent. Everything a stranger could be refused for — a malformed token, a
 * reset or unknown one, a deleted owner, a block either way, a pair who left
 * each other — answers with the **same** 404, so a link never tells anybody
 * more than "this link does not work".
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const limited = await rateLimit(request, userLimit("write", "friend-invite-open", me))
    if (limited) return limited

    // The owner's name and photo are part of taking part; so is the gate (SCRUM-331).
    const unfinished = await participationRefusal(me)
    if (unfinished) return forbiddenResponse(unfinished)

    const { token } = await params
    const notFound = () => notFoundResponse("This invite link doesn't work any more")
    if (!INVITE_TOKEN.test(token)) return notFound()

    const invite = await db.friend_invites.findUnique({
      where: { token },
      select: { user: { select: { ...personSelect, deletedAt: true } } },
    })
    /*
     * The same checks run whether or not the link resolved — against the
     * caller themselves when it did not — so a reset link and one whose owner
     * blocked you cost the same work and cannot be told apart by timing.
     */
    const connectable = await mayConnect(me, invite?.user.id ?? me)
    if (!invite || invite.user.deletedAt) return notFound()

    const owner = invite.user
    if (owner.id !== me && !connectable) return notFound()

    return successResponse({ person: personCard(owner), state: await friendState(me, owner.id) })
  } catch (error) {
    logger.error("Open invite link error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to open invite link")
  }
}
