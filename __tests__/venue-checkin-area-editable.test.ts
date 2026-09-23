import { readFileSync } from "fs"
import { join } from "path"

/*
 * A venue's check-in area must be editable after creation (SCRUM-204).
 *
 * Driven on staging: `QA Polygon Yard` was saved with its ring 1.2 km from its
 * pin (the SCRUM-203 bug drew it there) and nothing in the product could
 * correct it — `GeofenceEditor` was mounted only in the create wizard and the
 * event form, and the venue page's Save never sent a geofence at all, so even
 * the new drift guard had nothing to look at.
 */
const manage = readFileSync(join(__dirname, "..", "app", "dashboard", "venues", "[id]", "venue-manage.tsx"), "utf8")
const page = readFileSync(join(__dirname, "..", "app", "dashboard", "venues", "[id]", "page.tsx"), "utf8")

it("puts the area editor on the venue page and sends what is drawn", () => {
  expect(manage).toMatch(/<GeofenceEditor/)
  expect(manage).toMatch(/\.\.\.\(fence \? \{ geofence: fence \} : \{\}\)/)
})

it("loads the stored area to edit rather than starting from blank", () => {
  expect(page).toMatch(/geofence: true/)
  expect(page).toMatch(/geofence: venue\.geofence/)
  expect(manage).toMatch(/validateGeofence\(venue\.geofence\)/)
})

it("keeps a circle's centre and the pin together", () => {
  // The rule the create wizard already follows: a circle is its own pin.
  expect(manage).toMatch(/if \(next\.type === "circle"\) \{/)
  expect(manage).toMatch(/lat: String\(next\.lat\), lng: String\(next\.lng\)/)
})

/*
 * A shape nobody drew starts on the caller's pin (SCRUM-204, driven on
 * staging). On QA Polygon Yard, choosing Circle seeded the circle on the
 * drifted ring 1.2 km away; the pin follows a circle, so the correct pin was
 * dragged to the wrong place and Save would have passed the drift check by
 * moving the venue. "Use building outline" searched around the same wrong spot.
 */
const editor = readFileSync(join(__dirname, "..", "components", "geofence-editor.tsx"), "utf8")

it("seeds a switched-to circle and the building search on the pin, not on the shape being replaced", () => {
  const fn = editor.slice(editor.indexOf("function anchor("), editor.indexOf("function centroid("))
  // The pin is consulted first — before either shape.
  expect(fn.indexOf("if (pin) return [pin.lat, pin.lng]")).toBeGreaterThan(-1)
  expect(fn.indexOf("if (pin)")).toBeLessThan(fn.indexOf('fence.type === "circle"'))

  const switchMode = editor.slice(editor.indexOf("function switchMode("), editor.indexOf("return (", editor.indexOf("function switchMode(")))
  expect(switchMode).toContain("anchor(fence, givenCentre, fallbackCentre)")
  const importer = editor.slice(editor.indexOf("const importFootprint"), editor.indexOf("setImporting(true)"))
  expect(importer).toMatch(/anchor\(\s*fence,\s*pinLat !== undefined && pinLng !== undefined \? \{ lat: pinLat, lng: pinLng \} : undefined,/)
})
