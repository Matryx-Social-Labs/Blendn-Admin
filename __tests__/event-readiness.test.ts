import { readFileSync } from "fs"
import { join } from "path"

import type { EventFormValues } from "@/components/event-form/schema"
import { eventReadiness, TIGHT_FENCE_METRES } from "@/lib/event-readiness"

const ROOT = join(__dirname, "..")

/** A form state that publishes cleanly, so each test perturbs exactly one thing. */
const ok = (over: Partial<EventFormValues> = {}): Partial<EventFormValues> => ({
  title: "Sunset Sessions",
  start_time: "2026-10-01T18:00",
  end_time: "2026-10-01T22:00",
  timezone: "Asia/Kolkata",
  latitude: 12.97,
  longitude: 77.59,
  check_in_radius: 120,
  category_ids: ["cat-1"],
  cover_image_url: "https://example.invalid/cover.jpg",
  ...over,
})

describe("eventReadiness", () => {
  it("says nothing when the event is publishable", () => {
    expect(eventReadiness(ok())).toEqual({ blockers: [], warnings: [] })
  })

  it("blocks on no pin and no fence, which is what canPublish refuses", () => {
    /*
     * The whole reason this module exists. `canPublish` refuses this and the
     * organiser only found out by pressing Create at the bottom of a 5,683px
     * form, having scrolled past the map that fixes it.
     */
    const { blockers } = eventReadiness(ok({ latitude: undefined, longitude: undefined }))
    expect(blockers).toHaveLength(1)
    expect(blockers[0].message).toMatch(/pin on the map/i)
  })

  it("accepts a VALID fence with no pin, exactly as the server does", () => {
    /*
     * `canPublish` returns ok on a valid geofence alone — the coordinates are
     * the fallback, not the requirement. Mirroring it loosely would nag about
     * something the server is happy with.
     *
     * The fixture is a REAL circle. The earlier version used `{ type: "circle" }`
     * with no centre and no radius, which is not a valid fence — the assertion
     * passed, but for the wrong reason, and would have passed identically
     * whether the rule validated the fence or merely checked it was truthy.
     */
    expect(
      eventReadiness(
        ok({
          latitude: undefined,
          longitude: undefined,
          geofence: { type: "circle", lat: 12.97, lng: 77.59, radius: 120, buffer: 20 },
        })
      ).blockers
    ).toEqual([])
  })

  it("blocks a fence that is present but not yet drawn", () => {
    /*
     * The live case, found by a coverage pass. `geofence-editor.tsx`'s
     * `switchMode` writes `{ type: "polygon", ring: [], buffer }` the moment
     * somebody clicks the polygon toggle — before drawing a single point.
     *
     * Truthy. So a rule of `Boolean(values.geofence)` flipped the strip to
     * "Ready to publish" while the server's `validateGeofence` returned
     * `ring_too_short` and refused on Save — the strip reintroducing the exact
     * bug it was built to prevent, mid-session.
     */
    const { blockers } = eventReadiness(
      ok({
        latitude: undefined,
        longitude: undefined,
        geofence: { type: "polygon", ring: [], buffer: 0 },
      })
    )
    expect(blockers).toHaveLength(1)
    expect(blockers[0].message).toMatch(/pin on the map/i)
  })

  it("a half-drawn fence does not rescue a missing pin", () => {
    // The pair that matters: an invalid fence must not satisfy the rule on its
    // own, and it must not mask the absence of coordinates either.
    expect(
      eventReadiness(ok({ geofence: { type: "polygon", ring: [], buffer: 0 } })).blockers
    ).toEqual([])
    expect(
      eventReadiness(
        ok({ latitude: undefined, longitude: undefined, geofence: { type: "circle" } })
      ).blockers
    ).toHaveLength(1)
  })

  it("names the radius that cannot be submitted, instead of Save doing nothing", () => {
    /*
     * K1.4. `check_in_radius` is derived as `round(radius + buffer)`, the zod
     * floor is 10, and **no FormMessage for this field is rendered anywhere** —
     * so a 5m circle made the Save button silently inert.
     */
    const { blockers } = eventReadiness(ok({ check_in_radius: 5 }))
    expect(blockers).toHaveLength(1)
    expect(blockers[0].message).toMatch(/5m/)
    expect(blockers[0].message).toMatch(/smallest allowed is 10m/)
  })

  it("warns about a fence tighter than a GPS fix, without blocking it", () => {
    // 40 is submittable and legal. It is also smaller than the 35m accuracy
    // `lib/geofence.ts` assumes when a device reports none, so people standing
    // inside get turned away.
    const { blockers, warnings } = eventReadiness(ok({ check_in_radius: 40 }))
    expect(blockers).toEqual([])
    expect(warnings.some((w) => /tighter than a typical GPS fix/.test(w.message))).toBe(true)
    expect(TIGHT_FENCE_METRES).toBeGreaterThan(10) // the zod floor is not a usable floor
  })

  it("catches an event that ends before it starts", () => {
    const { blockers } = eventReadiness(
      ok({ start_time: "2026-10-01T22:00", end_time: "2026-10-01T18:00" })
    )
    expect(blockers.map((b) => b.message)).toContain("The event ends before it starts.")
  })

  it("blocks on a missing timezone, and says whose timezone it means", () => {
    /*
     * A blocker rather than a warning because of curation: the form used to
     * store the ADMIN's browser timezone, so a London admin curating a
     * Bengaluru event stored Europe/London — served to the mobile client, so
     * attendees saw the wrong local time, and it then surfaced as "ended with
     * nobody in" on the screen built to catch a wrong pin.
     */
    const { blockers } = eventReadiness(ok({ timezone: undefined }))
    expect(blockers).toHaveLength(1)
    expect(blockers[0].message).toMatch(/not the one you are in/)
  })

  it("keeps advice out of the blockers", () => {
    // No category and no cover image both publish fine. Putting them in the
    // same list as a refusal is how a blocker stops being read.
    const { blockers, warnings } = eventReadiness(
      ok({ category_ids: [], cover_image_url: undefined })
    )
    expect(blockers).toEqual([])
    expect(warnings).toHaveLength(2)
  })

  it("reports every blocker at once, not the first", () => {
    // The form is long. Fixing one thing, scrolling back, and being told about
    // the next is the failure this replaces.
    const { blockers } = eventReadiness({})
    expect(blockers.length).toBeGreaterThanOrEqual(4)
  })
})

describe("the form's rule and the server's rule do not drift", () => {
  it("mirrors canPublish's two conditions", () => {
    /*
     * STRUCTURAL. The duplication is deliberate — the server cannot trust a
     * form, and the mobile clone route creates events without touching this
     * code at all — so what has to be guarded is that the two say the SAME
     * thing. A form that nags about something the server allows trains people
     * to ignore it; one that stays quiet about a refusal is the bug this
     * module was written to fix, restored.
     *
     * Negative control: change `canPublish` to require coordinates even when a
     * geofence is present. Recorded in negative-controls.json.
     */
    const server = readFileSync(join(ROOT, "lib/geofence-input.ts"), "utf8")
    const form = readFileSync(join(ROOT, "lib/event-readiness.ts"), "utf8")

    // The server accepts a valid fence on its own...
    expect(server).toMatch(/if \(event\.geofence && validateGeofence\(event\.geofence\)\.ok\) return \{ ok: true \}/)
    // ...and so does the form, through the SAME function.
    expect(form).toMatch(/if \(!hasPin && !hasFence\)/)
    /*
     * How `hasFence` is computed, not only that it is used.
     *
     * This assertion pinned the consumer and not the producer, so it stayed
     * green while `hasFence` was `Boolean(values.geofence)` — a looser rule than
     * the server's, which is the whole failure. The repo's own note: a guard
     * must pin where a value comes from, not only what is done with it.
     */
    expect(form).toMatch(/validateGeofence\(values\.geofence\)\.ok/)

    // Both check coordinates explicitly against null/undefined rather than
    // truthily: `if (lat && lng)` is false at longitude 0, which is the bug
    // `canPublish` replaced and which a mirrored rule could reintroduce.
    expect(server).toMatch(/event\.latitude === null \|\| event\.longitude === null/)
    expect(form).toMatch(/typeof values\.latitude === "number"/)
  })
})
