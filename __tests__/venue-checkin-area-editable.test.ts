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
  // Through the shared place-and-area block since SCRUM-354.
  expect(manage).toMatch(/<VenueArea/)
  expect(manage).toMatch(/\.\.\.\(fence \? \{ geofence: fence \} : \{\}\)/)
})

it("loads the stored area to edit rather than starting from blank", () => {
  expect(page).toMatch(/geofence: true/)
  expect(page).toMatch(/geofence: venue\.geofence/)
  expect(manage).toMatch(/validateGeofence\(venue\.geofence\)/)
})

it("keeps the pin on the area's centre — any area, once it is a place (SCRUM-354)", () => {
  // Was: a circle is its own pin, and an outline left the pin where it was.
  // With the latitude and longitude boxes gone, the pin is the area's centre,
  // sent with the area only when the area moved.
  expect(manage).toMatch(/onArea=\{\(next, centre\) => \{\s*setFence\(next\)\s*if \(centre\) \{\s*setPin\(centre\)\s*setMoved\(true\)/)
  expect(manage).toMatch(/\.\.\.\(moved && pin \? \{ lat: pin\.lat, lng: pin\.lng \} : \{\}\)/)
  expect(manage).not.toMatch(/\{\.\.\.field\("lat"\)\}/)
  const area = readFileSync(join(__dirname, "..", "components", "venue-area.tsx"), "utf8")
  // A ring still being drawn is not a place: the pin waits for three corners.
  expect(area).toMatch(/const unfinished = next\.type === "polygon" && next\.ring\.length < 3\s*onArea\(next, unfinished \? null : fenceCentre\(next\)\)/)
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

it("keeps the \"different place\" answer while the same neighbours are near (React review, SCRUM-354)", () => {
  // Keyed on the pin, nudging one corner moved the centre and undid the answer.
  const create = readFileSync(join(__dirname, "..", "components", "venue-create-form.tsx"), "utf8")
  expect(create).toMatch(/const nearbyKey = nearby\.map\(\(v\) => v\.id\)\.sort\(\)\.join\(","\)/)
  expect(create).toMatch(/const acknowledged = ackFor !== null && ackFor === nearbyKey/)
  expect(create).not.toMatch(/pinKey/)
})

it("a type change resizes a stand-in circle, on both venue pages (React review, SCRUM-354)", () => {
  const create = readFileSync(join(__dirname, "..", "components", "venue-create-form.tsx"), "utf8")
  expect(create).toMatch(/geofence: followType\(d\.geofence, d\.venueType, t\)/)
  expect(manage).toMatch(/setFence\(\(f\) => followType\(f, venueType, next\)\)/)
})

it("a building lookup that lands late keeps a buffer changed meanwhile (React review, SCRUM-354)", () => {
  const area = readFileSync(join(__dirname, "..", "components", "venue-area.tsx"), "utf8")
  expect(area).toMatch(/setArea\(\{ type: "polygon", ring, buffer: latest\.current\?\.buffer \?\? buffer \}\)/)
})
