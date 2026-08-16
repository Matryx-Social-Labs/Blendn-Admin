import { NextRequest } from "next/server"
import { z } from "zod"

import {
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

/**
 * `ids` absent means "all of mine".
 *
 * Tapping the bell marks the sheet read; tapping one line marks that one. Both
 * are the same operation over a different set, so they are one endpoint rather
 * than two that can drift on authorisation.
 */
const markReadSchema = z.object({
  ids: z.array(z.string().uuid()).max(200).optional(),
})

/**
 * `POST /notifications/read` — mark notifications read.
 *
 * ## The `user_id` is always in the `where`
 *
 * Even when the caller names ids. Filtering on id alone would let anybody mark
 * *anybody's* notification read given a uuid — a small write, but it is
 * somebody else's row, and "you can only reach your own" is a property this
 * endpoint should hold structurally rather than by the ids being hard to guess.
 * `updateMany` silently affects zero rows for ids that are not yours, which is
 * the right answer: it neither errors nor confirms the row exists.
 *
 * ## Already-read rows are left alone
 *
 * `read_at: null` in the filter, so re-marking does not overwrite the original
 * timestamp. The column exists to answer "when did they see this", and a bell
 * tapped twice must not move the answer.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "notifications-read", user.userId))
    if (limited) return limited

    const body = await request.json().catch(() => ({}))
    const validation = markReadSchema.safeParse(body)
    if (!validation.success) return validationErrorResponse(validation.error)

    const { ids } = validation.data

    const { count } = await db.notifications.updateMany({
      where: {
        user_id: user.userId,
        read_at: null,
        ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      },
      data: { read_at: new Date() },
    })

    const unreadCount = await db.notifications.count({
      where: { user_id: user.userId, read_at: null },
    })

    return successResponse({ marked: count, unreadCount })
  } catch (error) {
    logger.error("Failed to mark notifications read", { error: String(error) })
    return serverErrorResponse("Failed to mark notifications read")
  }
}
