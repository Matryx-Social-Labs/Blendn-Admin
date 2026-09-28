import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { clientIpFrom } from "@/lib/client-ip"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit } from "@/lib/rate-limit"
import { INVITE_TOKEN, firstName, mayConnect, personCard, personSelect } from "@/lib/friends"
import { getAccessibleMediaUrl } from "@/lib/tigris"
import { successResponse, notFoundResponse, serverErrorResponse } from "@/lib/api-response"

/**
 * Per IP, because there is no account to key on. Generous for a person — the
 * preview is fetched once when a link is opened — and tight for a script, since
 * this is the one friends route a stranger can reach at all.
 */
const PREVIEW_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyGenerator: (req: NextRequest) => `friend-invite-preview:${clientIpFrom(req.headers)}`,
}

/**
 * GET /api/mobile/friends/invite/:token/preview — who sent this link, for
 * somebody who is not signed in yet.
 *
 * The invite screen opens before sign-up for a person new to the app, and the
 * authenticated route (`GET /friends/invite/:token`) cannot answer them. This
 * says only enough to make the link worth following: a **first name** and one
 * photo. Not the full name the signed-in route shows, not a user id, not a
 * friend state — the link may have been forwarded, and whoever holds it has not
 * agreed to anything yet.
 *
 * Every refusal is the authenticated route's one 404 (`NOT_FOUND`): a malformed,
 * unknown or reset token, a deleted or suspended owner. A caller who IS signed
 * in and sends their token also gets the block rule — a block either way, or a
 * pair who left each other, answers the same 404 — so a blocked person cannot
 * use the public door to see what the signed-in one hides.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const limited = await rateLimit(request, PREVIEW_LIMIT)
    if (limited) return limited

    const { token } = await params
    const notFound = () => notFoundResponse("This invite link doesn't work any more")
    if (!INVITE_TOKEN.test(token)) return notFound()

    const invite = await db.friend_invites.findUnique({
      where: { token },
      select: { user: { select: { ...personSelect, deletedAt: true, suspended_at: true } } },
    })
    if (!invite || invite.user.deletedAt || invite.user.suspended_at) return notFound()
    const owner = invite.user

    // Optional: a bad or expired token is treated as nobody, never as a 401.
    const viewer = await getAuthenticatedUser(request)
    if (viewer && viewer.userId !== owner.id && !(await mayConnect(viewer.userId, owner.id))) {
      return notFound()
    }

    const card = personCard(owner)
    return successResponse({
      name: firstName(card.name),
      photoUrl: card.photo ? getAccessibleMediaUrl(card.photo) : null,
    })
  } catch (error) {
    logger.error("Invite preview error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to open invite link")
  }
}
