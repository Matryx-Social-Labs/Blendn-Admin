import { readFileSync } from "fs"
import { join } from "path"
import { resolveFence } from "@/lib/geofence"
import {
  evaluatePresence,
  DEPARTURE_GRACE_MINUTES,
  DEPARTURE_ALLOWANCE_MINUTES,
} from "@/lib/presence"

/**
 * "Where is the fence" had three answers, and the one on the hot path failed
 * open through unreachable code.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const CIRCLE = { type: "circle", lat: 12.97, lng: 77.59, radius: 50, buffer: 0 }

describe("C1/C2 — one fence resolver", () => {
  it("prefers the event's own fence", () => {
    const fence = resolveFence({
      geofence: CIRCLE,
      venue: { geofence: { ...CIRCLE, radius: 500 } },
      latitude: 1,
      longitude: 1,
      check_in_radius: 30,
    })
    expect(fence).toMatchObject({ radius: 50 })
  })

  it("falls back to the venue's, which schema.prisma has always promised", () => {
    /*
     * The schema says events inherit the venue's geofence. Nothing on the
     * server honoured it at the door — the "inheritance" was a prefill in the
     * event form, and the one server-side fallback was unreachable.
     */
    const fence = resolveFence({
      geofence: null,
      venue: { geofence: { ...CIRCLE, radius: 500 } },
      latitude: 1,
      longitude: 1,
      check_in_radius: 30,
    })
    expect(fence).toMatchObject({ radius: 500 })
  })

  it("falls back to coordinates and a radius, for events older than the column", () => {
    const fence = resolveFence({
      geofence: null,
      venue: null,
      latitude: 12.97,
      longitude: 77.59,
      check_in_radius: 30,
    })
    expect(fence).not.toBeNull()
  })

  it("returns null only when there is genuinely nothing to judge against", () => {
    expect(resolveFence({ geofence: null, venue: null, latitude: null, longitude: null })).toBeNull()
  })

  it("is the only resolver on all three paths", () => {
    /*
     * The presence route's fallback was `validateGeofence(a) ?? validateGeofence(b)`,
     * which can never fall through: `validateGeofence` returns `{ ok: false }`,
     * never null. The venue branch was unreachable code and `legacyGeofence` was
     * never consulted, so every event created before the geofence column existed
     * answered `inside / no_geofence` FOR EVER — the presence check failing open
     * while looking like it worked.
     */
    for (const rel of [
      "app/api/mobile/events/[eventId]/presence/route.ts",
      "app/api/mobile/events/[eventId]/checkin/route.ts",
      "lib/presence-sweeper.ts",
    ]) {
      const src = code(rel)
      expect(src).toMatch(/resolveFence\(/)
      expect(src).not.toMatch(/validateGeofence\(/)
      expect(src).not.toMatch(/legacyGeofence\(/)
    }
  })

  it("does not let two select fragments claim the venue relation", () => {
    /*
     * `fenceSelect` and `eventPermissionSelect` both want `venue`, and object
     * spread means the second silently wins. The check-in route needs
     * `owner_org_id` to tell staff from guests AND `geofence` to fall back on,
     * so it merges them by hand — spreading `fenceSelect` there would have
     * turned every staff check-in into a guest one.
     */
    const src = code("app/api/mobile/events/[eventId]/checkin/route.ts")
    expect(src).toMatch(/venue: \{ select: \{ owner_org_id: true, \.\.\.fenceVenueSelect \} \}/)
    expect(src).not.toMatch(/\.\.\.fenceSelect/)
  })
})

describe("C3 — the mass-checkout guard has a floor", () => {
  it("needs enough departures for a share to be evidence", () => {
    /*
     * The share alone made auto-checkout unreachable in a small room: one
     * person leaving a room of two is 100%, one of three is 33%, and both trip
     * 25%. So nobody was ever closed out at a book club, and at the end of any
     * event — when everybody leaves at once — the guard tripped by construction
     * and the room never emptied.
     */
    const src = code("lib/presence-sweeper.ts")
    expect(src).toMatch(/MASS_CHECKOUT_FLOOR = 5/)
    expect(src).toMatch(/departures\.length >= MASS_CHECKOUT_FLOOR &&/)
  })
})

describe("C4 — the prompt is gone, and so is the question nobody was asked", () => {
  const NOW = new Date("2026-08-23T21:00:00Z")
  const ENDS = new Date("2026-08-23T23:00:00Z")
  const ago = (m: number) => new Date(NOW.getTime() - m * 60_000)
  const state = (leftAreaAt: Date | null) =>
    ({ kind: "attendee" as const, leftAreaAt, lastSeenAt: NOW })

  it("no longer emits a prompt action", () => {
    const d = evaluatePresence(
      state(ago(DEPARTURE_GRACE_MINUTES + 1)),
      { point: { lat: 0, lng: 0 }, accuracy: null },
      CIRCLE as never,
      ENDS,
      NOW
    )
    expect(d.action).toBe("stay")
  })

  it("keeps the total tolerance at twenty minutes", () => {
    /*
     * Removing the fiction must not also halve how long somebody may be
     * outside. The thesis names indoor GPS on cheap Android in dense venues as
     * a risk to the core mechanic; tightening this is a separate decision.
     */
    expect(DEPARTURE_ALLOWANCE_MINUTES).toBe(20)
    const out = evaluatePresence(
      state(ago(DEPARTURE_ALLOWANCE_MINUTES + 1)),
      { point: { lat: 0, lng: 0 }, accuracy: null },
      CIRCLE as never,
      ENDS,
      NOW
    )
    expect(out.action).toBe("auto_checkout")
    // Not `no_response`: nobody was asked anything.
    expect(out.reason).toBe("left_area")
  })

  it("stops reading and writing departure_prompted_at", () => {
    /*
     * The column is left in place rather than migrated away — the same call the
     * plan makes for `event_check_ins.kind`: cheaper than a migration, and
     * re-adding the concept later is then additive. What matters is that
     * nothing depends on it.
     */
    expect(code("lib/presence.ts")).not.toMatch(/departurePromptedAt/)
    expect(code("lib/presence-sweeper.ts")).not.toMatch(/departure_prompted_at: true/)
    expect(code("app/api/mobile/events/[eventId]/presence/route.ts")).not.toMatch(
      /departure_prompted_at: now/
    )
  })
})
