import { readFileSync } from "fs"
import { join } from "path"

/*
 * The event form's "Where" is one map (owner's call, 2026-09-27).
 *
 * It had two: `LocationPicker` (a search, its own pin, its own circle) above
 * the check-in area editor. They disagreed — the pin moved and the area stayed
 * wherever it had been drawn, once one existed — so an event could save a pin
 * in one place and a fence in another. `followPin` (lib/geofence.ts) decides
 * what the area does when the pin moves; its behaviour is pinned in
 * geofence.test.ts. This pins the wiring that makes it the only map.
 */
const src = readFileSync(join(__dirname, "../components/event-form/location-section.tsx"), "utf8")

describe("the event form's Where section", () => {
  it("renders one map: no LocationPicker beside the check-in area editor", () => {
    expect(src).not.toMatch(/<LocationPicker/)
    expect(src.match(/<GeofenceEditor/g)).toHaveLength(1)
  })

  it("puts the address search on that map and the address under it", () => {
    expect(src).toMatch(/overlay=\{<AddressSearch onPick=\{moveTo\} \/>\}/)
    expect(src).toMatch(/caption=\{\s*<FormField[\s\S]*?name="address"/)
  })

  it("moves the area with the pin — for a search and for a venue with no area of its own", () => {
    const moveTo = src.slice(src.indexOf("function moveTo("), src.indexOf("function onFenceChange("))
    expect(moveTo).toMatch(/followPin\(/)
    const inherit = src.slice(src.indexOf("function inherit("), src.indexOf("function unlink("))
    expect(inherit).toMatch(/followPin\(/)
  })

  it("keeps check_in_radius covering the area — outlines too, grown and shrunk with them (SCRUM-350)", () => {
    // It was written for circles only, so the ~260 m stadium outline kept 100.
    const setFence = src.slice(src.indexOf("function setFence("), src.indexOf("function moveTo("))
    expect(setFence).toMatch(/phoneCheckInRadius\(\{ geofence: fence \}\)/)
    expect(setFence).not.toMatch(/fence\?\.type === "circle"/)
  })

  it("keeps the pin readable for e2e/venue-pin.spec.ts", () => {
    expect(src).toMatch(/data-lat=\{initialLat \?\? ""\} data-lng=\{initialLng \?\? ""\}/)
  })

  it("does not describe a purple ring that no longer exists", () => {
    expect(src).not.toMatch(/purple/i)
  })

  it("rewrites the address only when the area is another place — samePlace, for circles and outlines alike", () => {
    // samePlace's rule is pinned in geofence.test.ts, including the stadium
    // whose own outline read as a new place when judged by its centre.
    const onFence = src.slice(src.indexOf("function onFenceChange("), src.indexOf("function inherit("))
    expect(onFence).toMatch(/if \(samePlace\(before, fence\)\) return\s*\n\s*const mine = \+\+reverseSeq\.current/)
    expect(onFence).not.toMatch(/fence\.type !== "circle"/)
  })
})

describe("the map's supporting parts", () => {
  it("a pick cancels a pending search, so 'Searching…' cannot stick", () => {
    const search = readFileSync(join(__dirname, "../components/event-form/address-search.tsx"), "utf8")
    const pick = search.slice(search.indexOf("function pick("), search.indexOf("const showList"))
    expect(pick).toMatch(/clearTimeout\(timer\.current\)/)
    expect(pick).toMatch(/setSearching\(false\)/)
  })

  it("the map brings its own stylesheet (SCRUM-344)", () => {
    // It borrowed LocationPicker's runtime <link>; with that picker gone from
    // the event form, and never on the venue pages, tiles stacked unstyled and
    // the circle drew 3,000 px below the map. e2e/venue-pin.spec.ts checks the
    // marker is inside the map's box.
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    expect(editor).toMatch(/^import "leaflet\/dist\/leaflet\.css"$/m)
  })

  it("draws a saved area once the map exists, not only when the area next changes (SCRUM-345)", () => {
    // The map is created after `import("leaflet")` resolves; the draw effect
    // had already run and returned. The venue page never re-rendered after
    // that, so its saved area was never drawn.
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    expect(editor).toMatch(/mapRef\.current = map\s*\n\s*setMapReady\(true\)/)
    const draw = editor.slice(editor.indexOf("/* --------------------------------------------------------------- draw --- */"))
    expect(draw.slice(0, draw.indexOf("/* ------------------------------------------------------ OSM footprint --- */"))).toMatch(/\}, \[mapReady, fence,/)
  })

  it("frames an imported outline, and keeps the search clear of the zoom control", () => {
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    const imp = editor.slice(editor.indexOf("const importFootprint"), editor.indexOf("/* --------------------------------------------------------------- view --- */"))
    expect(imp).toMatch(/mapRef\.current\?\.fitBounds\(ring/)
    // Leaflet's zoom control is 10px in and 34px wide; the search starts past it.
    expect(editor).toMatch(/className="absolute left-12 top-2\.5 z-\[800\]/)
  })

  it("LocationPicker loads the stylesheet from the package, not unpkg (CSP style-src)", () => {
    const picker = readFileSync(join(__dirname, "../components/location-picker.tsx"), "utf8")
    expect(picker).toMatch(/^import "leaflet\/dist\/leaflet\.css"$/m)
    expect(picker).not.toMatch(/unpkg\.com\/leaflet@[^"]*\/leaflet\.css/)
  })

  it("a fence replaced from outside ends tracing, so a venue's outline does not take clicks as corners", () => {
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    // …and drops a note about the outline it replaced ("Couldn't reach
    // OpenStreetMap" sat under "Outline cleared" on staging).
    expect(editor).toMatch(/if \(fence\.type !== prevType\) \{\s*setPrevType\(fence\.type\)\s*if \(fence\.type !== "polygon"\) \{\s*setDrawing\(false\)\s*setImportNote\(null\)/)
  })
})
