import { validateLocationInput, canPublish } from "@/lib/geofence-input"
import { GEOFENCE_LIMITS } from "@/lib/geofence"

/**
 * Server-side bounds on the check-in area.
 *
 * These did not exist. The create and update routes passed `check_in_radius`
 * from the request body into Prisma untouched, and the only limit in the
 * product was a slider in a form — which is not a limit, it is a suggestion to
 * anyone holding a HTTP client.
 */

describe("check_in_radius is bounded server-side", () => {
  it("accepts an ordinary radius", () => {
    const r = validateLocationInput({ check_in_radius: 50 })
    expect(r.ok).toBe(true)
    expect(r.values.check_in_radius).toBe(50)
  })

  it("refuses the 10 km value a seed script already sets", () => {
    // scripts/add-bangalore-event.ts:44 sets 10000, and nothing stopped it.
    const r = validateLocationInput({ check_in_radius: 10_000 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("cannot exceed")
  })

  it("refuses a radius that would swallow the city", () => {
    expect(validateLocationInput({ check_in_radius: 100_000 }).ok).toBe(false)
    expect(validateLocationInput({ check_in_radius: GEOFENCE_LIMITS.MAX_RADIUS + 1 }).ok).toBe(false)
  })

  it("accepts exactly the maximum", () => {
    expect(validateLocationInput({ check_in_radius: GEOFENCE_LIMITS.MAX_RADIUS }).ok).toBe(true)
  })

  it("refuses zero and negative", () => {
    // A zero radius is a geofence nobody can ever satisfy.
    expect(validateLocationInput({ check_in_radius: 0 }).ok).toBe(false)
    expect(validateLocationInput({ check_in_radius: -50 }).ok).toBe(false)
  })

  it("refuses nonsense rather than coercing it", () => {
    expect(validateLocationInput({ check_in_radius: "big" }).ok).toBe(false)
    expect(validateLocationInput({ check_in_radius: NaN }).ok).toBe(false)
    expect(validateLocationInput({ check_in_radius: Infinity }).ok).toBe(false)
  })

  it("leaves the field alone when it is absent", () => {
    // An update that does not mention the radius must not reset it.
    const r = validateLocationInput({})
    expect(r.ok).toBe(true)
    expect("check_in_radius" in r.values).toBe(false)
  })
})

describe("geofence input", () => {
  const circle = { type: "circle", lat: 12.9716, lng: 77.5946, radius: 50, buffer: 25 }

  it("accepts and normalises a circle", () => {
    const r = validateLocationInput({ geofence: circle })
    expect(r.ok).toBe(true)
    expect(r.values.geofence).toMatchObject({ type: "circle", radius: 50, buffer: 25 })
  })

  it("accepts a polygon", () => {
    const r = validateLocationInput({
      geofence: { type: "polygon", ring: [[12.97, 77.59], [12.971, 77.59], [12.971, 77.591]], buffer: 30 },
    })
    expect(r.ok).toBe(true)
  })

  it("lets an explicit null clear it back to the legacy columns", () => {
    const r = validateLocationInput({ geofence: null })
    expect(r.ok).toBe(true)
    expect(r.values.geofence).toBeNull()
  })

  it("gives a usable message per failure, not a generic one", () => {
    expect(validateLocationInput({ geofence: { ...circle, radius: 99_999 } }).error).toContain("radius")
    expect(validateLocationInput({ geofence: { ...circle, buffer: 9_999 } }).error).toContain("buffer")
    expect(
      validateLocationInput({ geofence: { type: "polygon", ring: [[1, 2]], buffer: 0 } }).error
    ).toContain("three points")
  })

  it("refuses a bounded radius smuggled in through the geofence", () => {
    // The cap has to apply on both paths or it applies on neither.
    expect(validateLocationInput({ geofence: { ...circle, radius: 10_000 } }).ok).toBe(false)
  })
})

describe("canPublish — an event with no location has no geofence", () => {
  it("allows an event with coordinates", () => {
    expect(canPublish({ latitude: 12.9716, longitude: 77.5946, geofence: null }).ok).toBe(true)
  })

  it("allows an event with a geofence and no legacy coordinates", () => {
    expect(
      canPublish({
        latitude: null,
        longitude: null,
        geofence: { type: "circle", lat: 12.97, lng: 77.59, radius: 50, buffer: 0 },
      }).ok
    ).toBe(true)
  })

  it("refuses an event with no location at all", () => {
    // This is the hole: such an event previously accepted check-ins from
    // anywhere on earth, because the route skipped the distance test entirely
    // when coordinates were missing.
    const r = canPublish({ latitude: null, longitude: null, geofence: null })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("map")
  })

  it("refuses when only one coordinate is set", () => {
    expect(canPublish({ latitude: 12.97, longitude: null, geofence: null }).ok).toBe(false)
    expect(canPublish({ latitude: null, longitude: 77.59, geofence: null }).ok).toBe(false)
  })

  it("allows longitude zero", () => {
    // `if (lat && lng)` is false here — the exact truthiness bug being fixed.
    expect(canPublish({ latitude: 51.4779, longitude: 0, geofence: null }).ok).toBe(true)
    expect(canPublish({ latitude: 0, longitude: 0, geofence: null }).ok).toBe(true)
  })

  it("falls back to coordinates when the stored geofence is corrupt", () => {
    // Bad data in one column must not make a real event unpublishable.
    expect(
      canPublish({ latitude: 12.97, longitude: 77.59, geofence: { type: "hexagon" } }).ok
    ).toBe(true)
  })
})
