import { NextRequest, NextResponse } from "next/server"
import { errorResponse } from "@/lib/api-response"

import { getAuth } from "@/lib/auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { logger } from "@/lib/logger"

export const dynamic = "force-dynamic"

/**
 * Nominatim, proxied.
 *
 * The map picker and the venue form called `nominatim.openstreetmap.org`
 * straight from the browser with no `User-Agent`, which is against
 * [OSM's usage policy](https://operations.osmfoundation.org/policies/nominatim/)
 * and a ban risk at volume. This is not hypothetical: Overpass returned `406`
 * to exactly that shape of request while backfilling venue data, and Nominatim
 * is the only geocoder this product has.
 *
 * Proxying also means one place to add caching, and one identity to be blocked
 * or not blocked as a whole rather than per-user.
 *
 * Dashboard-authenticated: geocoding is an authoring tool, and an open proxy
 * would be a free relay for anyone who found it.
 */

const NOMINATIM = "https://nominatim.openstreetmap.org"
const UA = "blendn-admin (https://blendn.app; ops@blendn.app)"

/**
 * Cached for a day.
 *
 * An address does not move. The policy asks for caching, and this turns a busy
 * authoring session into a handful of upstream calls.
 */
const CACHE_SECONDS = 86_400

export async function GET(req: NextRequest) {
  const session = await getAuth()
  if (!session?.user) return errorResponse("Unauthorized", 401)

  const limited = await rateLimit(req, userLimit("write", "geocode", session.user.id))
  if (limited) return limited

  const sp = req.nextUrl.searchParams
  const q = sp.get("q")?.trim()
  const lat = sp.get("lat")
  const lon = sp.get("lon")

  // Two modes, mirroring the two things the UI needs: name to pin, and pin to
  // address.
  let upstream: string
  if (q) {
    /*
     * The country restriction is configuration, not a constant.
     *
     * This was `countrycodes=in`, hardcoded, with nothing anywhere saying so —
     * a product constraint stated in one query parameter. It fails in the least
     * helpful way available: an organiser outside India types their venue, gets
     * no results and no explanation, and cannot work around it by typing
     * coordinates, because the form derives those from the pin they cannot
     * place.
     *
     * Default unchanged, so this alters nothing today. Set
     * `GEOCODE_COUNTRY_CODES=""` to search worldwide.
     */
    // Read directly rather than through `validateEnv()`, which re-parses the
    // whole environment and throws — not something a per-request path should
    // do. It is still declared in `lib/env.ts`, which is what documents it and
    // validates it at boot.
    const countries = (process.env.GEOCODE_COUNTRY_CODES ?? "in").trim()
    upstream =
      `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1` +
      (countries ? `&countrycodes=${encodeURIComponent(countries)}` : "")
  } else if (lat && lon && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    upstream = `${NOMINATIM}/reverse?lat=${Number(lat)}&lon=${Number(lon)}&format=json&addressdetails=1`
  } else {
    return NextResponse.json({ error: "q, or lat and lon, are required" }, { status: 400 })
  }

  try {
    const res = await fetch(upstream, {
      // `Accept-Language` is pinned here rather than passed through from the
      // caller. The venue form omitted it and the event form sent it, so the
      // same pin resolved to "München" from one screen and "Munich" from the
      // other — and both spellings ended up in `events.city`, splitting one
      // city across two entries in anything that groups by name. A header the
      // caller can forget is a header that will be forgotten.
      headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "en" },
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: CACHE_SECONDS },
    })
    if (!res.ok) {
      // Upstream refusing is not our caller's fault, and the UI should say the
      // search is unavailable rather than that the address does not exist.
      logger.warn("Nominatim upstream error", { status: res.status })
      return NextResponse.json({ error: "geocoder_unavailable" }, { status: 502 })
    }
    return NextResponse.json(await res.json(), {
      headers: { "Cache-Control": `private, max-age=${CACHE_SECONDS}` },
    })
  } catch (error) {
    logger.warn("Nominatim request failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: "geocoder_unavailable" }, { status: 502 })
  }
}
