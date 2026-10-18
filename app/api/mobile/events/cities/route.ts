import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import { ageFrom } from "@/lib/age"
import { browseCities } from "@/lib/address"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { realEventsWhere } from "@/lib/event-kind"
import { cityPlaces } from "@/lib/city-places"

async function viewerEvents(userId: string) {
  /*
   * Deliberately the same shape as the browse filter in `../route.ts`,
   * including the age gate. An 18+ event counted here but hidden there is
   * exactly the drift this endpoint exists to avoid.
   */
  const viewer = await db.profiles.findUnique({
    where: { id: userId },
    select: { age: true, date_of_birth: true },
  })
  // Derived rather than read off the row — see `ageFrom` in lib/age.ts. The
  // counts here must match the browse filter exactly, and that one derives.
  const viewerAge = ageFrom(viewer)

  return db.events.findMany({
    where: {
      deleted_at: null,
      ...realEventsWhere,
      status: "published",
      visibility: "public",
      end_time: { gte: new Date() },
      city: { not: null },
      ...(typeof viewerAge === "number"
        ? { OR: [{ min_age: null }, { min_age: { lte: viewerAge } }] }
        : {}),
    },
    select: { city: true, latitude: true, longitude: true },
  })
}

/**
 * The cities you can browse, with how many events and places are in each.
 *
 * A city with listed places but no events is a city too: its Places list is
 * full even before any organiser publishes there (seeded venues, SCRUM-699).
 * Listing only event cities left those unreachable from the picker.
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
     * The places Places lists, by the same visibility the venues route applies
     * (`cityPlaces`, cached). They do not depend on the viewer, so they load
     * alongside profile -> events rather than after them.
     * ponytail: the venues route also hides a venue an event has taken over
     * right now, so a city's placeCount can run a few above what opens; group
     * in SQL with that rule if the table outgrows a scan of three columns.
     */
    const [places, rows] = await Promise.all([cityPlaces(), viewerEvents(user.userId)])
    // Where the home map goes when the city is picked (step 2): its events' points, else its places'.
    return successResponse({ cities: browseCities(rows, places) })
  } catch (error) {
    logger.error("Failed to list event cities", { error })
    return serverErrorResponse("Failed to load cities")
  }
}
