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
