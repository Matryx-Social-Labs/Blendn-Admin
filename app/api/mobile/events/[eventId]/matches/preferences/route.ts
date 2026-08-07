import { NextRequest } from "next/server"
import { z } from "zod"

import {
  forbiddenResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
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
  /** Also make this the default for future events. */
  remember: z.boolean().optional(),
})

/**
 * Why you are here tonight, and whether you want to be named.
 *
 * Per event, because both genuinely change: someone open to dating at a Friday
 * party is often only there for the talk on Tuesday. Asking once at signup and
 * never again would get one of those wrong every time.
 *
 * `remember: true` also writes the profile default, which is what the "ask me
 * once" path in onboarding uses. Without it this is a one-night answer.
 *
 * Reveal defaults to false everywhere and is never flipped on implicitly — the
 * room is pseudonymous, and being named has to be something a person did rather
 * than something that happened to them.
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

    const checkIn = await db.event_check_ins.findFirst({
      where: { event_id: eventId, user_id: authUser.userId },
      select: { id: true },
    })
    if (!checkIn) return forbiddenResponse("Check in to this event first")

    const updated = await db.event_check_ins.update({
      where: { id: checkIn.id },
      data: {
        ...(intent !== undefined ? { intent } : {}),
        ...(revealed !== undefined ? { revealed } : {}),
      },
      select: { intent: true, revealed: true },
    })

    if (remember) {
      await db.profiles.update({
        where: { id: authUser.userId },
        data: {
          ...(intent !== undefined ? { intent_default: intent } : {}),
          ...(revealed !== undefined ? { reveal_by_default: revealed } : {}),
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
