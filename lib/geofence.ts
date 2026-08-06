import { haversineDistanceMeters } from "./geo"

/**
 * Geofencing for GPS check-in.
 *
 * The product's whole premise is that everyone in an event's chatroom is
 * physically there, so this file decides whether that is true. Both failure
 * directions are expensive and they are not symmetric:
 *
 *   - **too strict** — someone standing inside the venue cannot get in, and
 *     churns at the moment they were most engaged. The worse one.
 *   - **too loose** — the car park, the café next door, or a different event in
 *     the same complex joins the room, and the guarantee quietly stops holding.
 *
 * ## The three quantities
 *
 * `events.check_in_radius` is one number doing three jobs, which is why it
 * cannot be set correctly for both a 20m café and a 200m stadium:
 *
 *   1. **extent** — how big the venue actually is. A fact about the world.
 *   2. **buffer** — deliberate tolerance: the queue, the pavement, the car
 *      park. The organiser's call.
 *   3. **accuracy allowance** — how wrong *this* GPS fix is. The device reports
 *      it per reading; indoors it is routinely 20-65m.
 *
 * Separating them is the fix. Because the accuracy allowance is applied per
 * check-in, the authored shape no longer has to be inflated to absorb bad GPS —
 * so geometry can be tight (less overlap) *and* tolerant (fewer false
 * rejections), instead of trading one against the other.
 *
 * ## Why not PostGIS
 *
 * The check-in query loads one event and compares one point. There is no
 * spatial index to benefit from, and PostGIS would add an extension, a
 * migration and a second query dialect to serve that. Local equirectangular
 * projection is accurate to well under 1% at these distances, which is nothing
 * beside 30m of GPS noise. If "events near me" ever needs a real spatial index,
 * this is the seam.
 *
 * Pinned by __tests__/geofence.test.ts.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface LatLng {
  lat: number
  lng: number
}

export type Geofence =
  | { type: "circle"; lat: number; lng: number; radius: number; buffer: number }
  | { type: "polygon"; ring: [number, number][]; buffer: number }

export interface AccuracyPolicy {
  /** Used when the device reports no accuracy at all. */
  assumed: number
  /** Ceiling, so a device claiming 500m cannot check in from anywhere. */
  cap: number
}

export const DEFAULT_ACCURACY_POLICY: AccuracyPolicy = { assumed: 35, cap: 75 }

/* -------------------------------------------------------------------------- */
/* Local projection                                                            */
/* -------------------------------------------------------------------------- */

const METRES_PER_DEG_LAT = 111_320

/**
 * Project to local metres relative to an origin.
 *
 * Equirectangular: longitude degrees shrink by cos(latitude). Over the few
 * hundred metres a geofence spans this is accurate to a fraction of a metre,
 * and it makes every downstream calculation plain 2D geometry.
 */
function toLocal(point: LatLng, origin: LatLng): { x: number; y: number } {
  const latRad = (origin.lat * Math.PI) / 180
  return {
    x: (point.lng - origin.lng) * METRES_PER_DEG_LAT * Math.cos(latRad),
    y: (point.lat - origin.lat) * METRES_PER_DEG_LAT,
  }
}

/* -------------------------------------------------------------------------- */
/* Polygon geometry                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ray casting. Counts crossings of a ray heading east from the point.
 *
 * The `(yi > y) !== (yj > y)` test is the standard half-open rule: it counts a
 * vertex exactly once even when the ray passes straight through it, which is
 * what stops a point level with a vertex being reported as outside.
 */
export function pointInPolygon(point: LatLng, ring: [number, number][]): boolean {
  if (ring.length < 3) return false

  const { x, y } = { x: point.lng, y: point.lat }
  let inside = false

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i]
    const [yj, xj] = ring[j]
    const crosses = yi > y !== yj > y
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Shortest distance in metres from a point to a segment, in local coords. */
function distanceToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy

  // Degenerate segment — both endpoints are the same point.
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)

  // Projection parameter, clamped so it lands on the segment rather than the
  // infinite line the segment sits on.
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * Distance in metres from a point to a polygon.
 *
 * **Zero when inside.** Callers add the buffer and the accuracy allowance to
 * this, so an interior point must contribute nothing — otherwise a big venue
 * would be harder to check into from the middle than from the edge.
 */
export function distanceToPolygon(point: LatLng, ring: [number, number][]): number {
  if (ring.length < 3) return Infinity
  if (pointInPolygon(point, ring)) return 0

  const origin = { lat: ring[0][0], lng: ring[0][1] }
  const p = toLocal(point, origin)

  let nearest = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = toLocal({ lat: ring[j][0], lng: ring[j][1] }, origin)
    const b = toLocal({ lat: ring[i][0], lng: ring[i][1] }, origin)
    nearest = Math.min(nearest, distanceToSegment(p, a, b))
  }
  return nearest
}

/* -------------------------------------------------------------------------- */
/* The check-in decision                                                       */
/* -------------------------------------------------------------------------- */

/** Distance to the geofence's *extent*, before buffer or accuracy. */
export function distanceToGeofence(point: LatLng, fence: Geofence): number {
  if (fence.type === "circle") {
    const centreDistance = haversineDistanceMeters(point.lat, point.lng, fence.lat, fence.lng)
    // Zero inside, for the same reason as the polygon case.
    return Math.max(0, centreDistance - fence.radius)
  }
  return distanceToPolygon(point, fence.ring)
}

/**
 * How much slack this particular reading earns.
 *
 * A missing accuracy is treated as `assumed` rather than as zero: most clients
 * that omit it are not claiming a perfect fix, they simply did not send the
 * field, and treating that as perfect would reject people standing inside.
 */
export function accuracyAllowance(
  reported: number | null | undefined,
  policy: AccuracyPolicy = DEFAULT_ACCURACY_POLICY
): number {
  if (reported === null || reported === undefined || !Number.isFinite(reported)) {
    return policy.assumed
  }
  // Negative is nonsense from a broken client; treat as no information.
  if (reported < 0) return policy.assumed
  return Math.min(reported, policy.cap)
}

export type CheckInVerdict =
  | { ok: true; distance: number; allowance: number }
  | { ok: false; distance: number; allowance: number; shortfall: number }

/**
 * The decision. `shortfall` is how many metres short they were, which is what
 * the client shows — "you're about 40m outside" is actionable, "denied" is not.
 */
export function evaluateCheckIn(
  point: LatLng,
  fence: Geofence,
  reportedAccuracy?: number | null,
  policy: AccuracyPolicy = DEFAULT_ACCURACY_POLICY
): CheckInVerdict {
  const distance = distanceToGeofence(point, fence)
  const allowance = fence.buffer + accuracyAllowance(reportedAccuracy, policy)

  if (distance <= allowance) return { ok: true, distance, allowance }
  return { ok: false, distance, allowance, shortfall: distance - allowance }
}

/* -------------------------------------------------------------------------- */
/* Legacy bridge                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a geofence from the old point + radius columns.
 *
 * Every event predating `events.geofence` still works through this, so no
 * backfill is needed. The old `check_in_radius` conflated extent and tolerance,
 * so it is mapped entirely to extent with a zero buffer — the accuracy
 * allowance then makes it *more* permissive than before, never less. An event
 * that worked yesterday cannot start rejecting people today.
 */
export function legacyGeofence(
  latitude: number | null,
  longitude: number | null,
  radius: number | null
): Geofence | null {
  // Explicit null checks, not truthiness. The route this replaces used
  // `if (event.latitude && event.longitude)`, so an event at longitude 0 —
  // Greenwich, and everything on that meridian through France, Spain, Algeria
  // and Ghana — silently had no geofence at all and accepted check-ins from
  // anywhere on earth.
  if (latitude === null || longitude === null) return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  return {
    type: "circle",
    lat: latitude,
    lng: longitude,
    radius: radius && Number.isFinite(radius) && radius > 0 ? radius : 0,
    buffer: 0,
  }
}

/* -------------------------------------------------------------------------- */
/* Overlap                                                                     */
/* -------------------------------------------------------------------------- */

/** Centre and a radius that encloses the whole fence including its buffer. */
export function boundingCircle(fence: Geofence): { centre: LatLng; radius: number } {
  if (fence.type === "circle") {
    return { centre: { lat: fence.lat, lng: fence.lng }, radius: fence.radius + fence.buffer }
  }

  const ring = fence.ring
  const centre = {
    lat: ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
    lng: ring.reduce((sum, p) => sum + p[1], 0) / ring.length,
  }
  const radius = ring.reduce(
    (max, p) => Math.max(max, haversineDistanceMeters(centre.lat, centre.lng, p[0], p[1])),
    0
  )
  return { centre, radius: radius + fence.buffer }
}

/**
 * Do two geofences overlap?
 *
 * A **conservative** bounding-circle test: it flags some pairs that do not
 * strictly intersect. That is the right bias for a warning — a false warning
 * costs a glance, a missed one costs two events fighting over check-ins on the
 * night.
 *
 * Deliberately a warning and never a block. A conference with three tracks in
 * one building is *meant* to overlap, and refusing to save it would break a
 * real use case to prevent a hypothetical one.
 */
export function fencesOverlap(a: Geofence, b: Geofence): boolean {
  const ca = boundingCircle(a)
  const cb = boundingCircle(b)
  const between = haversineDistanceMeters(ca.centre.lat, ca.centre.lng, cb.centre.lat, cb.centre.lng)
  return between < ca.radius + cb.radius
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export const GEOFENCE_LIMITS = {
  /** Beyond this an event stops being "here" in any useful sense. */
  MAX_RADIUS: 2000,
  MAX_BUFFER: 250,
  /** Three points is a triangle; fewer is not a shape. */
  MIN_RING: 3,
  /** Enough for a traced building; a ring longer than this is a mistake. */
  MAX_RING: 200,
} as const

export type GeofenceError =
  | "bad_type"
  | "bad_coordinates"
  | "radius_out_of_range"
  | "buffer_out_of_range"
  | "ring_too_short"
  | "ring_too_long"

export function validateGeofence(value: unknown): { ok: true; fence: Geofence } | { ok: false; error: GeofenceError } {
  if (!value || typeof value !== "object") return { ok: false, error: "bad_type" }
  const f = value as Record<string, unknown>

  const buffer = Number(f.buffer ?? 0)
  if (!Number.isFinite(buffer) || buffer < 0 || buffer > GEOFENCE_LIMITS.MAX_BUFFER) {
    return { ok: false, error: "buffer_out_of_range" }
  }

  if (f.type === "circle") {
    const lat = Number(f.lat)
    const lng = Number(f.lng)
    if (!isValidLatLng(lat, lng)) return { ok: false, error: "bad_coordinates" }

    const radius = Number(f.radius)
    // Nothing bounded this server-side before: the API passed check_in_radius
    // straight into Prisma, and a seed script already sets 10km. One event with
    // a 100km radius swallows every other geofence in the city.
    if (!Number.isFinite(radius) || radius <= 0 || radius > GEOFENCE_LIMITS.MAX_RADIUS) {
      return { ok: false, error: "radius_out_of_range" }
    }
    return { ok: true, fence: { type: "circle", lat, lng, radius, buffer } }
  }

  if (f.type === "polygon") {
    const ring = f.ring
    if (!Array.isArray(ring)) return { ok: false, error: "bad_type" }
    if (ring.length < GEOFENCE_LIMITS.MIN_RING) return { ok: false, error: "ring_too_short" }
    if (ring.length > GEOFENCE_LIMITS.MAX_RING) return { ok: false, error: "ring_too_long" }

    const clean: [number, number][] = []
    for (const vertex of ring) {
      if (!Array.isArray(vertex) || vertex.length !== 2) return { ok: false, error: "bad_coordinates" }
      const lat = Number(vertex[0])
      const lng = Number(vertex[1])
      if (!isValidLatLng(lat, lng)) return { ok: false, error: "bad_coordinates" }
      clean.push([lat, lng])
    }
    return { ok: true, fence: { type: "polygon", ring: clean, buffer } }
  }

  return { ok: false, error: "bad_type" }
}

function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  )
}
