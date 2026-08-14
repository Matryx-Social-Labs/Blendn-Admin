import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import { ageFrom } from "@/lib/age"
import { groupCities } from "@/lib/address"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"

/**
 * The cities you can browse, with how many events are in each.
 *
 * Browse scope is one variable — the selected city — and the client needs a
 * list to choose from before it can show anything. The server owns that list
 * rather than the client deriving one by reverse-geocoding on first launch:
 * a geocode on the cold path can fail and leave a new install with a blank
 * screen, and a second naming authority would disagree with `lib/address.ts`
 * about spelling, quotas and failures.
 *
 * GPS still has a job — offering *"you're near Bengaluru, switch?"* — but it
 * never decides what can be seen.
 *
 * ## The invariant
 *
 * **A city listed here with a count of N must open with N events.** The counts
 * come from the same `where` the browse query builds, so the two cannot drift:
 * anything that would hide an event from the list also removes it from the
 * count. A picker that promises three events and opens empty is worse than one
 * that omits the city, because the user blames the app rather than the filter.
 *
 * Events with no `city` are absent from both, which is the same rule applied
 * consistently rather than an omission. `scripts/backfill-event-cities.ts`
 * gives the older rows a city; new ones get one from the map at authoring time.
 *
 * ## Why the grouping happens in JS and not in SQL
 *
 * Postgres would group `"Bengaluru"` and `"bengaluru "` as two cities. Those
 * are one place, and only rows written before `lib/address.ts` can differ that
 * way — so `groupCities` folds them on `cityKey`. A `groupBy` in SQL would need
 * the same normalisation as a functional index, which is a migration to solve
 * a problem the backfill removes.
 *
 * The folding rules live in `lib/address.ts` so they can be tested without a
 * database; this route is the query and the age gate.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    /*
     * Deliberately the same shape as the browse filter in `../route.ts`,
     * including the age gate. An 18+ event counted here but hidden there is
     * exactly the drift this endpoint exists to avoid.
     */
    const viewer = await db.profiles.findUnique({
      where: { id: user.userId },
      select: { age: true, date_of_birth: true },
    })
    // Derived rather than read off the row — see `ageFrom` in lib/age.ts. The
    // counts here must match the browse filter exactly, and that one derives.
    const viewerAge = ageFrom(viewer)

    const rows = await db.events.findMany({
      where: {
        deleted_at: null,
        status: "published",
        visibility: "public",
        end_time: { gte: new Date() },
        city: { not: null },
        ...(typeof viewerAge === "number"
          ? { OR: [{ min_age: null }, { min_age: { lte: viewerAge } }] }
          : {}),
      },
      select: { city: true },
    })

    return successResponse({ cities: groupCities(rows.map((row) => row.city)) })
  } catch (error) {
    logger.error("Failed to list event cities", { error })
    return serverErrorResponse("Failed to load cities")
  }
}
