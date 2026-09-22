import { readFileSync } from "fs"
import { join } from "path"

/*
 * Choosing "Trace outline" must not move the map (SCRUM-203).
 *
 * Driven on staging: search "Church Street" → Trace outline → the map jumped
 * to a hardcoded Bengaluru centre, the fence was drawn there, and the venue
 * was saved with its pin 1.3 km from its own fence. `centroid([])` returned
 * a constant; the recentre effect followed it.
 */
const src = readFileSync(join(__dirname, "..", "components", "geofence-editor.tsx"), "utf8")

it("has no hardcoded city centre left to jump to", () => {
  expect(src).not.toMatch(/\[12\.9716, 77\.5946\]/)
  expect(src).toMatch(/function centroid\(ring: \[number, number\]\[\], fallback: \[number, number\]\)/)
  expect(src).toMatch(/return centre \? \[centre\.lat, centre\.lng\] : fallback/)
})

it("does not recentre on an empty ring", () => {
  const effect = src.slice(src.indexOf("Only when it is outside the current bounds"), src.indexOf("/* ------------------------------------------------------ OSM footprint --- */"))
  expect(effect).toContain('if (map && !(fence.type === "polygon" && fence.ring.length === 0)) {')
  expect(effect).toContain("centroid(fence.ring, [fallbackCentre.lat, fallbackCentre.lng])")
})
