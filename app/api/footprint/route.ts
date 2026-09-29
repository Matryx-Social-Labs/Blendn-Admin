import { NextRequest, NextResponse } from "next/server"
import { errorResponse } from "@/lib/api-response"
import { getAuth } from "@/lib/auth"
import { isValidLatLng } from "@/lib/geofence"
import { logger } from "@/lib/logger"
import { OSM_USER_AGENT, OUTLINE_BUILDING_WITHIN_M, pickBuilding } from "@/lib/outline"
import { rateLimit, userLimit } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

/**
 * The building a pinned place sits in — Overpass, proxied (SCRUM-351).
 *
 * The editor's "Use building outline" called overpass-api.de from the browser
 * with no User-Agent: against OSM's usage policy, the thing `/api/geocode` was
 * written to stop. And it said "Couldn't reach OpenStreetMap" for a busy server
 * and for a place with no building alike.
 *
 * The main instance is often overloaded (504 after 8.7 s on 2026-09-27), so a
 * failure tries one community mirror. A GET with the query in the URL, so the
 * fetch cache can keep an answer for a day — a building does not move, and a
 * venue's outline is saved once anyway.
 *
 * Three answers the UI tells apart: `{ ring }`, `{ ring: null }` (no building
 * here), and 502 `lookup_unavailable` (try again, or draw it).
 */
const UPSTREAMS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
]
const TIMEOUT_MS = 8_000
const CACHE_SECONDS = 86_400

export async function GET(req: NextRequest) {
  const session = await getAuth()
  if (!session?.user) return errorResponse("Unauthorized", 401)

  const limited = await rateLimit(req, userLimit("write", "footprint", session.user.id))
  if (limited) return limited

  // `Number(null)` and `Number("")` are 0, a real coordinate: a missing one
  // must not send (0, 0) to Overpass.
  const lat = Number(req.nextUrl.searchParams.get("lat") || NaN)
  const lng = Number(req.nextUrl.searchParams.get("lon") || NaN)
  if (!isValidLatLng(lat, lng)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 })
  }

  // The stadium or building the pin is in, and any building within reach of a
  // pin on the pavement.
  const query =
    `[out:json][timeout:8];is_in(${lat},${lng})->.a;` +
    `(way(pivot.a)[building];way(pivot.a)[leisure=stadium];` +
    `way(around:${OUTLINE_BUILDING_WITHIN_M},${lat},${lng})[building];);out geom;`

  // Configuration, so CI's e2e can point it at recorded answers — and then
  // only there, never on to the public mirror (SCRUM-357).
  const configured = process.env.FOOTPRINT_UPSTREAM?.trim()
  for (const upstream of configured ? [configured] : UPSTREAMS) {
    try {
      const res = await fetch(`${upstream}?data=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": OSM_USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        next: { revalidate: CACHE_SECONDS },
      })
      if (!res.ok) {
        logger.warn("Overpass upstream error", { upstream, status: res.status })
        continue
      }
      const body = (await res.json()) as { elements?: unknown }
      return NextResponse.json(
        { ring: pickBuilding(body.elements, { lat, lng }) },
        { headers: { "Cache-Control": `private, max-age=${CACHE_SECONDS}` } }
      )
    } catch (error) {
      logger.warn("Overpass request failed", {
        upstream,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return NextResponse.json({ error: "lookup_unavailable" }, { status: 502 })
}
