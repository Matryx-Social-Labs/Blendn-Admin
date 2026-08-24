import { NextRequest } from "next/server"

import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-response"
import { resolveFence, fenceSelect } from "@/lib/geofence"
import { performCheckout } from "@/lib/checkout"
import {
  evaluatePresence,
  shouldPersistPing,
  DEPARTURE_ALLOWANCE_MINUTES,
  PING_INTERVAL_MINUTES,
  type PresenceState,
} from "@/lib/presence"

export const dynamic = "force-dynamic"

/**
 * "Am I still counted as here?"
 *
 * The client pings this every few minutes while checked in. Check-in used to be
 * a one-shot gate — it proved you were at the venue once and nothing revisited
 * the claim — so anyone who left without pressing "check out" stayed counted
 * for ever, which was the largest single source of error in the live number.
 *
 * The response carries everything the client needs to render without a second
 * call: whether they are inside, how far out they are, and when the grace
 * period runs out.
 *
 * Writes only when something changed, or when the last write is older than the
 * ping interval. Five hundred attendees pinging every five minutes is a hundred
 * writes a minute if each one is persisted, and near zero if not.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await params

  const authUser = await getAuthenticatedUser(request)
  if (!authUser) return unauthorizedResponse()

  const limited = await rateLimit(request, userLimit("write", "presence", authUser.userId))
  if (limited) return limited

  let body: { latitude?: number; longitude?: number; accuracy?: number | null }
  try {
    body = await request.json()
  } catch {
    return errorResponse("Invalid JSON body", 400)
  }

  const { latitude, longitude } = body
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return errorResponse("latitude and longitude are required", 400)
  }

  const checkIn = await db.event_check_ins.findFirst({
    where: { event_id: eventId, user_id: authUser.userId, status: "checked_in" },
    orderBy: { check_in_time: "desc" },
    select: {
      id: true,
      kind: true,
      last_seen_at: true,
      left_area_at: true,
      departure_prompted_at: true,
      occurrence: { select: { end_time: true } },
      // Spread, not hand-picked: a select missing `check_in_radius` reads as
      // "no legacy fence" and silently fails open for every pre-column event.
      event: { select: { ...fenceSelect } },
    },
  })

  // Not checked in is not an error — the client may be racing a checkout it
  // made itself, or one the sweeper made. Tell it plainly so it can stop
  // pinging.
  if (!checkIn) {
    return successResponse({ status: "not_checked_in" })
  }

  /*
   * One resolver. See `resolveFence` in lib/geofence.ts.
   *
   * This was `validateGeofence(event) ?? validateGeofence(venue)`, which can
   * never fall through -- `validateGeofence` returns `{ ok: false }`, never
   * null. The venue branch was unreachable code, and `legacyGeofence` was never
   * consulted at all, so every event created before the geofence column existed
   * answered `inside / no_geofence` for ever. The presence check failed open
   * while looking like it worked, and it is the only thing between a check-in
   * and an occupancy number.
   */
  const fence = resolveFence(checkIn.event)
  if (!fence) {
    // Genuinely nothing to judge against -- no fence, no venue fence, and no
    // coordinates. Say so rather than guessing them out of the room.
    return successResponse({ status: "inside", reason: "no_geofence" })
  }

  const now = new Date()
  const state: PresenceState = {
    kind: checkIn.kind,
    leftAreaAt: checkIn.left_area_at,
    lastSeenAt: checkIn.last_seen_at,
  }
  const decision = evaluatePresence(
    state,
    { point: { lat: latitude, lng: longitude }, accuracy: body.accuracy ?? null },
    fence,
    checkIn.occurrence.end_time,
    now
  )

  if (decision.action === "auto_checkout") {
    await performCheckout(
      checkIn.id,
      decision.reason === "occurrence_ended" ? "occurrence_ended" : "left_area",
      now
    )
    return successResponse({ status: "checked_out", reason: decision.reason })
  }

  if (shouldPersistPing(decision, state, now)) {
    await db.event_check_ins.update({
      where: { id: checkIn.id },
      data: {
        last_seen_at: now,
        ...(decision.action === "record_departure" ? { left_area_at: now } : {}),
        ...(decision.action === "clear_departure"
          ? { left_area_at: null, departure_prompted_at: null }
          : {}),
      },
    })
  }

  const leftAt = decision.action === "record_departure" ? now : checkIn.left_area_at
  /*
   * When they stop being counted, not when the grace ends.
   *
   * This reported `leftAt + DEPARTURE_GRACE_MINUTES`, which was the moment the
   * (undelivered) prompt would have fired rather than the moment of checkout --
   * so the client counted down to a deadline ten minutes before the real one.
   */
  const graceEndsAt = leftAt
    ? new Date(leftAt.getTime() + DEPARTURE_ALLOWANCE_MINUTES * 60_000).toISOString()
    : null

  return successResponse({
    /*
     * `prompt` is gone as a status. It was returned when the server had just
     * written `departure_prompted_at` and sent nothing anywhere -- so the one
     * client that could act on it was the one already pinging, which knows it is
     * outside because it just said so.
     */
    status:
      decision.reason === "inside" || decision.reason === "returned"
        ? "inside"
        : "outside",
    reason: decision.reason,
    shortfallMetres: decision.shortfall ? Math.round(decision.shortfall) : null,
    graceEndsAt,
    nextPingInSeconds: PING_INTERVAL_MINUTES * 60,
  })
}
