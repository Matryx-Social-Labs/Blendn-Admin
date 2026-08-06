import { GEOFENCE_LIMITS, validateGeofence, type Geofence } from "./geofence"

/**
 * Server-side bounds for what an event may claim as its check-in area.
 *
 * Nothing bounded this before: `app/api/events/route.ts` passed
 * `check_in_radius` straight from the request body into Prisma, and the only
 * limit anywhere was a client-side slider. `scripts/add-bangalore-event.ts`
 * already sets 10 km. One event with a 100 km radius silently swallows every
 * other geofence in the city, and nothing would have stopped it.
 *
 * Shared by the create and update routes so the two cannot drift.
 *
 * Pinned by __tests__/geofence-input.test.ts.
 */

export interface LocationInput {
  latitude?: unknown
  longitude?: unknown
  check_in_radius?: unknown
  geofence?: unknown
}

export interface LocationResult {
  ok: boolean
  error?: string
  /** Normalised values to write. Absent keys are left untouched. */
  values: { check_in_radius?: number; geofence?: Geofence | null }
}

export function validateLocationInput(input: LocationInput): LocationResult {
  const values: LocationResult["values"] = {}

  if (input.check_in_radius !== undefined && input.check_in_radius !== null) {
    const radius = Number(input.check_in_radius)
    if (!Number.isFinite(radius) || radius <= 0) {
      return { ok: false, error: "Check-in radius must be a positive number of metres.", values }
    }
    if (radius > GEOFENCE_LIMITS.MAX_RADIUS) {
      return {
        ok: false,
        error: `Check-in radius cannot exceed ${GEOFENCE_LIMITS.MAX_RADIUS} m. Beyond that an event stops meaning "here" — use a polygon geofence for a large venue instead.`,
        values,
      }
    }
    values.check_in_radius = radius
  }

  if (input.geofence !== undefined) {
    // Explicit null clears it and falls back to the point + radius columns.
    if (input.geofence === null) {
      values.geofence = null
    } else {
      const result = validateGeofence(input.geofence)
      if (!result.ok) {
        return { ok: false, error: GEOFENCE_MESSAGES[result.error], values }
      }
      values.geofence = result.fence
    }
  }

  return { ok: true, values }
}

const GEOFENCE_MESSAGES: Record<string, string> = {
  bad_type: "Geofence must be a circle or a polygon.",
  bad_coordinates: "Geofence coordinates are not valid latitude/longitude pairs.",
  radius_out_of_range: `Geofence radius must be between 1 and ${GEOFENCE_LIMITS.MAX_RADIUS} m.`,
  buffer_out_of_range: `Geofence buffer must be between 0 and ${GEOFENCE_LIMITS.MAX_BUFFER} m.`,
  ring_too_short: "A polygon geofence needs at least three points.",
  ring_too_long: `A polygon geofence cannot have more than ${GEOFENCE_LIMITS.MAX_RING} points.`,
}

/**
 * May this event be published?
 *
 * Coordinates are required. Without them the check-in route has no geofence to
 * compare against, and before this change that meant the event accepted
 * check-ins **from anywhere on earth** — silently, because nothing ever
 * required a location.
 */
export function canPublish(event: {
  latitude: number | null
  longitude: number | null
  geofence: unknown
}): { ok: boolean; reason?: string } {
  if (event.geofence && validateGeofence(event.geofence).ok) return { ok: true }

  // Explicit null checks: `if (lat && lng)` is false at longitude 0, which is
  // exactly the bug this replaces.
  if (event.latitude === null || event.longitude === null) {
    return {
      ok: false,
      reason:
        "Set the event's location on the map before publishing — GPS check-in needs somewhere to check against.",
    }
  }
  return { ok: true }
}
