import {
  pointInPolygon,
  distanceToPolygon,
  distanceToGeofence,
  accuracyAllowance,
  evaluateCheckIn,
  legacyGeofence,
  boundingCircle,
  fencesOverlap,
  validateGeofence,
  ringSelfIntersects,
  GEOFENCE_LIMITS,
  type Geofence,
} from "@/lib/geofence"

/**
 * Geofencing.
 *
 * This decides whether someone is physically at an event, which is the one
 * thing the product is built on — and it shipped with zero tests. Both failure
 * directions are silent: a wrongly-rejected attendee blames their phone, and a
 * wrongly-accepted one nobody notices at all.
 *
 * Distances are asserted with tolerances because the projection is approximate
 * by design; the tolerances are far tighter than GPS noise.
 */

// A ~100m square in Bangalore. 0.0009° lat ≈ 100m.
const SQUARE: [number, number][] = [
  [12.9700, 77.5900],
  [12.9700, 77.5909],
  [12.9709, 77.5909],
  [12.9709, 77.5900],
]
const INSIDE = { lat: 12.97045, lng: 77.59045 }

describe("pointInPolygon", () => {
  it("finds a point in the middle", () => {
    expect(pointInPolygon(INSIDE, SQUARE)).toBe(true)
  })

  it("rejects a point outside", () => {
    expect(pointInPolygon({ lat: 12.9750, lng: 77.5904 }, SQUARE)).toBe(false)
    expect(pointInPolygon({ lat: 12.9704, lng: 77.5950 }, SQUARE)).toBe(false)
  })

  it("rejects a point level with a vertex but outside the ring", () => {
    // The classic ray-casting failure: a ray passing exactly through a vertex
    // gets counted twice (or zero times) and flips the answer.
    expect(pointInPolygon({ lat: 12.9700, lng: 77.5800 }, SQUARE)).toBe(false)
    expect(pointInPolygon({ lat: 12.9709, lng: 77.6000 }, SQUARE)).toBe(false)
  })

  it("handles a concave ring — an L-shaped venue", () => {
    // The notch must read as outside even though it is inside the bounding box.
    const L: [number, number][] = [
      [12.9700, 77.5900],
      [12.9700, 77.5910],
      [12.9705, 77.5910],
      [12.9705, 77.5905],
      [12.9710, 77.5905],
      [12.9710, 77.5900],
    ]
    expect(pointInPolygon({ lat: 12.9702, lng: 77.5902 }, L)).toBe(true)
    expect(pointInPolygon({ lat: 12.9708, lng: 77.5908 }, L)).toBe(false) // the notch
  })

  it("refuses a degenerate ring rather than guessing", () => {
    expect(pointInPolygon(INSIDE, [])).toBe(false)
    expect(pointInPolygon(INSIDE, [[12.97, 77.59]])).toBe(false)
    expect(pointInPolygon(INSIDE, [[12.97, 77.59], [12.971, 77.591]])).toBe(false)
  })
})

describe("distanceToPolygon", () => {
  it("is zero anywhere inside", () => {
    // Not "distance to the centroid" — a big venue must not be harder to check
    // into from the middle than from the edge.
    expect(distanceToPolygon(INSIDE, SQUARE)).toBe(0)
    expect(distanceToPolygon({ lat: 12.97005, lng: 77.59005 }, SQUARE)).toBe(0)
  })

  it("measures to the nearest edge, not the nearest vertex", () => {
    // Due north of the middle of the top edge. Nearest vertex is ~50m further
    // along; a vertex-only implementation would overstate this badly.
    const d = distanceToPolygon({ lat: 12.9718, lng: 77.59045 }, SQUARE)
    expect(d).toBeGreaterThan(90)
    expect(d).toBeLessThan(110)
  })

  it("measures a diagonal approach from the corner", () => {
    const d = distanceToPolygon({ lat: 12.9718, lng: 77.5918 }, SQUARE)
    expect(d).toBeGreaterThan(120)
    expect(d).toBeLessThan(150)
  })

  it("is Infinity for a ring that is not a shape", () => {
    expect(distanceToPolygon(INSIDE, [[12.97, 77.59]])).toBe(Infinity)
  })
})

describe("distanceToGeofence — circles", () => {
  const fence: Geofence = { type: "circle", lat: 12.9716, lng: 77.5946, radius: 50, buffer: 0 }

  it("is zero inside the radius", () => {
    expect(distanceToGeofence({ lat: 12.9716, lng: 77.5946 }, fence)).toBe(0)
    expect(distanceToGeofence({ lat: 12.97163, lng: 77.5946 }, fence)).toBe(0)
  })

  it("measures from the edge, not the centre", () => {
    // ~200m north of centre, minus the 50m radius, ≈150m.
    const d = distanceToGeofence({ lat: 12.9734, lng: 77.5946 }, fence)
    expect(d).toBeGreaterThan(140)
    expect(d).toBeLessThan(165)
  })
})

describe("accuracyAllowance", () => {
  it("uses the device's own number", () => {
    expect(accuracyAllowance(40)).toBe(40)
  })

  it("caps a device claiming absurd accuracy", () => {
    // Otherwise a client reporting 5000m checks in from another city.
    expect(accuracyAllowance(500)).toBe(75)
    expect(accuracyAllowance(5000)).toBe(75)
  })

  it("assumes a realistic figure when the field is missing", () => {
    // Treating a missing value as zero would reject people standing inside,
    // because plenty of clients simply do not send it.
    expect(accuracyAllowance(undefined)).toBe(35)
    expect(accuracyAllowance(null)).toBe(35)
  })

  it("treats nonsense as no information", () => {
    expect(accuracyAllowance(-10)).toBe(35)
    expect(accuracyAllowance(NaN)).toBe(35)
    expect(accuracyAllowance(Infinity)).toBe(35)
  })

  it("passes through a very good fix unchanged", () => {
    expect(accuracyAllowance(4)).toBe(4)
    expect(accuracyAllowance(0)).toBe(0)
  })
})

describe("evaluateCheckIn — the decision", () => {
  const cafe: Geofence = { type: "circle", lat: 12.9716, lng: 77.5946, radius: 20, buffer: 25 }

  it("lets someone standing inside in", () => {
    expect(evaluateCheckIn({ lat: 12.9716, lng: 77.5946 }, cafe, 30).ok).toBe(true)
  })

  it("lets a poor fix just outside in, because the device said it was poor", () => {
    // ~60m out. Buffer 25 + accuracy 60 (capped to 75) = 85 > 60. This is the
    // case the old fixed-radius rule got wrong: it rejected a real attendee
    // whose phone had already admitted it was unsure.
    const verdict = evaluateCheckIn({ lat: 12.97213, lng: 77.5946 }, cafe, 60)
    expect(verdict.ok).toBe(true)
  })

  it("keeps out someone genuinely far away even with a poor fix", () => {
    // 500m out. Even the capped allowance cannot reach.
    const verdict = evaluateCheckIn({ lat: 12.9761, lng: 77.5946 }, cafe, 150)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.shortfall).toBeGreaterThan(300)
  })

  it("reports how far short they were, for the client to show", () => {
    // "You're about 40m outside" is actionable; "denied" is not.
    const verdict = evaluateCheckIn({ lat: 12.9761, lng: 77.5946 }, cafe, 5)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.shortfall).toBeGreaterThan(0)
      expect(verdict.shortfall).toBeCloseTo(verdict.distance - verdict.allowance, 5)
    }
  })

  it("works the same for a stadium-sized polygon", () => {
    // The case one radius cannot serve: 100m across, and the middle is as valid
    // as the edge.
    const stadium: Geofence = { type: "polygon", ring: SQUARE, buffer: 30 }
    expect(evaluateCheckIn(INSIDE, stadium, 20).ok).toBe(true)
    expect(evaluateCheckIn({ lat: 12.9800, lng: 77.5904 }, stadium, 20).ok).toBe(false)
  })

  it("a bigger buffer admits someone a fixed radius would have refused", () => {
    const tight: Geofence = { type: "circle", lat: 12.9716, lng: 77.5946, radius: 20, buffer: 0 }
    const generous: Geofence = { ...tight, buffer: 100 }
    const queueOutside = { lat: 12.97219, lng: 77.5946 } // ~65m out
    expect(evaluateCheckIn(queueOutside, tight, 5).ok).toBe(false)
    expect(evaluateCheckIn(queueOutside, generous, 5).ok).toBe(true)
  })
})

describe("legacyGeofence — every existing event keeps working", () => {
  it("builds a circle from the old columns", () => {
    const fence = legacyGeofence(12.9716, 77.5946, 30)
    expect(fence).toEqual({ type: "circle", lat: 12.9716, lng: 77.5946, radius: 30, buffer: 0 })
  })

  it("returns null when there are no coordinates", () => {
    // The caller must then refuse the check-in. Previously a coordinate-less
    // event accepted check-ins from anywhere on earth.
    expect(legacyGeofence(null, 77.5946, 30)).toBeNull()
    expect(legacyGeofence(12.9716, null, 30)).toBeNull()
    expect(legacyGeofence(null, null, 30)).toBeNull()
  })

  it("keeps a fence at longitude zero", () => {
    // The bug this replaces: `if (event.latitude && event.longitude)` is
    // falsy at 0, so everything on the Greenwich meridian silently had no
    // geofence at all.
    expect(legacyGeofence(51.4779, 0, 30)).not.toBeNull()
    expect(legacyGeofence(0, 77.5946, 30)).not.toBeNull()
    expect(legacyGeofence(0, 0, 30)).not.toBeNull()
  })

  it("survives a missing or nonsense radius", () => {
    // Narrowed rather than cast: legacyGeofence returns the union, and a
    // polygon has no radius. If it ever returns one, this stops compiling.
    for (const bad of [null, -5, NaN]) {
      const fence = legacyGeofence(12.97, 77.59, bad)
      expect(fence?.type).toBe("circle")
      if (fence?.type === "circle") expect(fence.radius).toBe(0)
    }
  })

  it("is never stricter than the old rule was", () => {
    // A legacy event's radius becomes pure extent with a zero buffer, so the
    // accuracy allowance only ever adds tolerance. Nobody who could check in
    // yesterday is refused today.
    const fence = legacyGeofence(12.9716, 77.5946, 30)!
    const atTheOldBoundary = { lat: 12.971869, lng: 77.5946 } // ~30m out
    expect(evaluateCheckIn(atTheOldBoundary, fence, 0).ok).toBe(true)
  })
})

describe("overlap detection", () => {
  const at = (lat: number, lng: number, radius: number, buffer = 0): Geofence => ({
    type: "circle", lat, lng, radius, buffer,
  })

  it("flags two events in the same building", () => {
    expect(fencesOverlap(at(12.9716, 77.5946, 50), at(12.9716, 77.5946, 50))).toBe(true)
  })

  it("does not flag venues comfortably apart", () => {
    expect(fencesOverlap(at(12.9716, 77.5946, 50), at(12.9900, 77.5946, 50))).toBe(false)
  })

  it("counts the buffer as part of the footprint", () => {
    // ~200m apart. 50+50 does not reach, but 50+150 buffer does — and the
    // buffer is where check-ins are accepted, so it has to count.
    const a = at(12.9716, 77.5946, 50)
    const b = at(12.9734, 77.5946, 50)
    expect(fencesOverlap(a, b)).toBe(false)
    expect(fencesOverlap({ ...a, buffer: 150 }, b)).toBe(true)
  })

  it("handles a polygon against a circle", () => {
    const stadium: Geofence = { type: "polygon", ring: SQUARE, buffer: 0 }
    expect(fencesOverlap(stadium, at(12.97045, 77.59045, 10))).toBe(true)
    expect(fencesOverlap(stadium, at(12.9900, 77.5946, 10))).toBe(false)
  })

  it("is symmetric", () => {
    const a = at(12.9716, 77.5946, 50, 20)
    const b = at(12.9720, 77.5946, 30)
    expect(fencesOverlap(a, b)).toBe(fencesOverlap(b, a))
  })
})

describe("boundingCircle", () => {
  it("encloses every vertex of a polygon", () => {
    const { centre, radius } = boundingCircle({ type: "polygon", ring: SQUARE, buffer: 0 })
    for (const [lat, lng] of SQUARE) {
      expect(distanceToGeofence({ lat, lng }, {
        type: "circle", lat: centre.lat, lng: centre.lng, radius, buffer: 0,
      })).toBe(0)
    }
  })
})

describe("validateGeofence — nothing bounded this server-side before", () => {
  const circle = { type: "circle", lat: 12.9716, lng: 77.5946, radius: 50, buffer: 25 }

  it("accepts a sane circle", () => {
    const r = validateGeofence(circle)
    expect(r.ok).toBe(true)
  })

  it("refuses a radius that swallows the city", () => {
    // A seed script already sets 10km, and the API passed it straight through.
    expect(validateGeofence({ ...circle, radius: 10_000 })).toEqual({
      ok: false, error: "radius_out_of_range",
    })
    expect(validateGeofence({ ...circle, radius: GEOFENCE_LIMITS.MAX_RADIUS + 1 }).ok).toBe(false)
  })

  it("refuses a zero or negative radius", () => {
    expect(validateGeofence({ ...circle, radius: 0 }).ok).toBe(false)
    expect(validateGeofence({ ...circle, radius: -50 }).ok).toBe(false)
  })

  it("refuses an out-of-range buffer", () => {
    expect(validateGeofence({ ...circle, buffer: -1 }).ok).toBe(false)
    expect(validateGeofence({ ...circle, buffer: 10_000 })).toEqual({
      ok: false, error: "buffer_out_of_range",
    })
  })

  it("refuses impossible coordinates", () => {
    expect(validateGeofence({ ...circle, lat: 91 }).ok).toBe(false)
    expect(validateGeofence({ ...circle, lng: 181 }).ok).toBe(false)
    expect(validateGeofence({ ...circle, lat: "here" }).ok).toBe(false)
  })

  it("accepts latitude and longitude zero", () => {
    expect(validateGeofence({ ...circle, lat: 0, lng: 0 }).ok).toBe(true)
  })

  it("accepts a polygon and normalises its ring", () => {
    const r = validateGeofence({ type: "polygon", ring: SQUARE, buffer: 30 })
    expect(r.ok).toBe(true)
    if (r.ok && r.fence.type === "polygon") expect(r.fence.ring).toHaveLength(4)
  })

  it("refuses a ring that is not a shape", () => {
    expect(validateGeofence({ type: "polygon", ring: [[12.97, 77.59]], buffer: 0 })).toEqual({
      ok: false, error: "ring_too_short",
    })
  })

  it("refuses an absurdly long ring", () => {
    const huge = Array.from({ length: GEOFENCE_LIMITS.MAX_RING + 1 }, () => [12.97, 77.59])
    expect(validateGeofence({ type: "polygon", ring: huge, buffer: 0 })).toEqual({
      ok: false, error: "ring_too_long",
    })
  })

  it("refuses malformed vertices", () => {
    expect(validateGeofence({ type: "polygon", ring: [[12.97], [1, 2], [3, 4]], buffer: 0 }).ok).toBe(false)
    expect(validateGeofence({ type: "polygon", ring: ["a", [1, 2], [3, 4]], buffer: 0 }).ok).toBe(false)
  })

  it("refuses anything that is not a geofence at all", () => {
    for (const bad of [null, undefined, 42, "circle", {}, { type: "hexagon" }]) {
      expect(validateGeofence(bad).ok).toBe(false)
    }
  })

  it("defaults a missing buffer to zero rather than rejecting", () => {
    const r = validateGeofence({ type: "circle", lat: 12.97, lng: 77.59, radius: 50 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fence.buffer).toBe(0)
  })
})

describe("self-crossing rings are refused", () => {
  it("accepts an ordinary convex ring", () => {
    expect(ringSelfIntersects(SQUARE)).toBe(false)
  })

  it("accepts a concave ring — an L-shaped venue is legitimate", () => {
    const L: [number, number][] = [
      [12.9700, 77.5900], [12.9700, 77.5910], [12.9705, 77.5910],
      [12.9705, 77.5905], [12.9710, 77.5905], [12.9710, 77.5900],
    ]
    expect(ringSelfIntersects(L)).toBe(false)
  })

  it("catches a bow tie", () => {
    // Swapping two adjacent corners of a square crosses the edges. Ray casting
    // then reports the middle of one lobe as OUTSIDE, so an attendee standing
    // in the venue is refused with nothing anyone could act on.
    const bowTie: [number, number][] = [
      [12.9700, 77.5900], [12.9700, 77.5909],
      [12.9709, 77.5900], [12.9709, 77.5909],
    ]
    expect(ringSelfIntersects(bowTie)).toBe(true)
  })

  it("never flags a triangle, which cannot cross itself", () => {
    expect(ringSelfIntersects([[12.97, 77.59], [12.971, 77.59], [12.971, 77.591]])).toBe(false)
  })

  it("does not mistake adjacent edges sharing a vertex for a crossing", () => {
    // Every edge touches its neighbour by construction, including the closing
    // edge meeting the first — a naive check reports every ring as crossed.
    expect(ringSelfIntersects(SQUARE)).toBe(false)
    const pentagon: [number, number][] = [
      [12.9700, 77.5900], [12.9700, 77.5910], [12.9706, 77.5914],
      [12.9712, 77.5910], [12.9712, 77.5900],
    ]
    expect(ringSelfIntersects(pentagon)).toBe(false)
  })

  it("is rejected by validateGeofence with a message you can act on", () => {
    const bowTie = [[12.9700, 77.5900], [12.9700, 77.5909], [12.9709, 77.5900], [12.9709, 77.5909]]
    expect(validateGeofence({ type: "polygon", ring: bowTie, buffer: 0 })).toEqual({
      ok: false, error: "ring_self_intersects",
    })
  })
})
