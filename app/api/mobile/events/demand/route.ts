import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"

import { cityKey } from "@/lib/address"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

/**
 * "I'm here and there's nothing on."
 *
 * The app already knows this — it renders *"You're in Saarbrücken, nothing here
 * yet"* — and until now it threw the fact away. Every one of those is a person
 * telling us where to launch, and it is the only demand data this product gets
 * before it has any supply.
 *
 * ## Counting people, not opens
 *
 * The write is an upsert on `(user_id, city_key)`, so reopening the app all
 * week is one row with a higher `opens`. That is the whole point: "forty people
 * in Saarbrücken" has to mean forty people, and a log of opens cannot say that
 * — one enthusiast would outrank a crowd.
 *
 * ## Deliberately not a tracker
 *
 * No coordinates. City and country are what a launch decision needs; a per-open
 * GPS trail of every user would be a much larger promise about their privacy
 * than this feature is worth, and it would have to be defended in a policy we
 * would rather keep short.
 *
 * The client sends this **at most once per session**, and the rate limit here
 * is the backstop rather than the design — a chatty or malicious client cannot
 * inflate a city's count, because the count is `count(*)` over distinct users
 * and a second write from the same user changes nothing.
 */

const demandSchema = z.object({
  city: z.string().min(1).max(100),
  /** Two-letter code or a name; both are useful for grouping and neither is required. */
  country: z.string().min(1).max(100).optional(),
})

export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("write", "city-demand", authUser.userId))
    if (limited) return limited

    const parsed = demandSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const city = parsed.data.city.trim()
    const key = cityKey(city)
    if (!key) {
      return validationErrorResponse(
        new z.ZodError([
          { code: "custom", path: ["city"], message: "city cannot be blank" },
        ])
      )
    }

    await db.city_demand.upsert({
      where: { user_id_city_key: { user_id: authUser.userId, city_key: key } },
      // `city` is refreshed on the way through so a spelling improvement in the
      // geocoder reaches the dashboard label without a backfill.
      update: { opens: { increment: 1 }, last_seen: new Date(), city },
      create: {
        user_id: authUser.userId,
        city,
        city_key: key,
        country: parsed.data.country?.trim() || null,
      },
    })

    // Nothing useful to return. The client fired this and moved on; it must not
    // be waiting on the answer to render anything.
    return successResponse({ recorded: true })
  } catch (error) {
    logger.error("Failed to record city demand", { error })
    return serverErrorResponse("Failed to record")
  }
}
