import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse } from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"

/**
 * `GET /amenities` — the amenity vocabulary.
 *
 * ## Public, like `/categories`
 *
 * No auth: this is the same class of data as the category list — a fixed
 * vocabulary the client renders, carrying nothing about any person or any
 * event. Requiring a token would only mean the picker cannot be drawn until
 * after sign-in, for no gain.
 *
 * ## Retired amenities are not returned
 *
 * `is_active = false` is how an amenity is withdrawn, because deleting one
 * would rewrite what past events said they offered — the foreign key is
 * `Restrict` for exactly that reason. Retired rows still resolve on an event
 * that references them; they simply stop being offered for new ones.
 */
export async function GET(_request: NextRequest) {
  try {
    const amenities = await db.amenities.findMany({
      where: { is_active: true },
      // The vocabulary's own order. Alphabetical would put "Accessible
      // Entrance" at the top of every picker and every event card.
      orderBy: { sort_order: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        subtitle: true,
        icon: true,
      },
    })

    return successResponse({ amenities })
  } catch (error) {
    logger.error("Failed to list amenities", { error: String(error) })
    return serverErrorResponse("Failed to load amenities")
  }
}
