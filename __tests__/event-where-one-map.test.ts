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

  it("asks where once — listed venues first, then places — and writes the address under the map (SCRUM-353)", () => {
    // There were two inputs for one question: a venue box and an address
    // search on the map. One now; listed venues bring their area, places add one.
    expect(src).toMatch(/<WhereSearch[\s\S]*?onPickVenue=\{inherit\}[\s\S]*?onPickPlace=\{pickPlace\}/)
    expect(src).not.toMatch(/AddressSearch|VenuePicker|overlay=/)
    expect(src).toMatch(/caption=\{\s*<FormField[\s\S]*?name="address"/)
  })

  it("a place that is only a pin looks for its building, and keeps the circle — saying so — when OSM has none", () => {
    const pickPlace = src.slice(src.indexOf("function pickPlace("), src.indexOf("function unlink("))
    expect(pickPlace).toMatch(/setAreaSource\("circle"\)[\s\S]*?fetch\(`\/api\/footprint\?lat=/)
    expect(pickPlace).toMatch(/setAreaSource\("building"\)/)
  })

  it("a late building lookup never overwrites a drawing or a later pick", () => {
    const pickPlace = src.slice(src.indexOf("function pickPlace("), src.indexOf("function unlink("))
    expect(pickPlace).toMatch(/if \(mine !== footprintSeq\.current \|\| !ring\) return/)
    const onFence = src.slice(src.indexOf("function onFenceChange("), src.indexOf("function inherit("))
    expect(onFence).toMatch(/\+\+footprintSeq\.current/)
    const inherit = src.slice(src.indexOf("function inherit("), src.indexOf("function pickPlace("))
    expect(inherit).toMatch(/\+\+footprintSeq\.current/)
  })

  it("the citation stays true: a buffer nudge keeps the source; the editor's own import is a building (React review)", () => {
    const onFence = src.slice(src.indexOf("function onFenceChange("), src.indexOf("function inherit("))
    expect(onFence).toMatch(/how === "import"[\s\S]*?setAreaSource\("building"\)/)
    expect(onFence).toMatch(/!sameShape\(prev, fence\)[\s\S]*?setAreaSource\("drawn"\)/)
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    const imp = editor.slice(editor.indexOf("const importFootprint"), editor.indexOf("/* --------------------------------------------------------------- view --- */"))
    expect(imp).toMatch(/onChange\(\{ type: "polygon", ring, buffer: fence\.buffer \}, "import"\)/)
  })

  it("a lookup still in flight when the section goes away writes nothing (React review)", () => {
    expect(src).toMatch(/useEffect\(\s*\(\) => \(\) => \{\s*footprintSeq\.current\+\+/)
  })

  it("leaving the input cancels a search in flight, so it cannot reopen the list (React review)", () => {
    const search = readFileSync(join(__dirname, "../components/event-form/where-search.tsx"), "utf8")
    const blur = search.slice(search.indexOf("function cancel("), search.indexOf("function pick("))
    expect(blur).toMatch(/clearTimeout\(timer\.current\)/)
    expect(blur).toMatch(/\+\+seq\.current/)
    expect(search).toMatch(/onBlur=\{cancel\}/)
  })

  it("the two groups are real listbox groups, heard by a screen reader (React review)", () => {
    const search = readFileSync(join(__dirname, "../components/event-form/where-search.tsx"), "utf8")
    expect(search).toMatch(/role="group"[\s\S]*?aria-labelledby=/)
  })

  it("the area cites its source under the map — the section's memorable detail", () => {
    expect(src).toMatch(/<AreaSourceLine\s+source=\{areaSource\}/)
    for (const said of ["Area from the venue", "Outline from OpenStreetMap", "Building outline found nearby", "No outline in OpenStreetMap"]) {
      expect(src).toContain(said)
    }
  })

  it("moves the area with the pin — for a search and for a venue with no area of its own", () => {
    const moveTo = src.slice(src.indexOf("function moveTo("), src.indexOf("function onFenceChange("))
    expect(moveTo).toMatch(/areaAfterPick\(/)
    const inherit = src.slice(src.indexOf("function inherit("), src.indexOf("function pickPlace("))
    expect(inherit).toMatch(/areaAfterPick\(/)
  })

  it("keeps check_in_radius covering the area — outlines too, grown and shrunk with them (SCRUM-350)", () => {
    // It was written for circles only, so the ~260 m stadium outline kept 100.
    const setFence = src.slice(src.indexOf("function setFence("), src.indexOf("function moveTo("))
    expect(setFence).toMatch(/phoneCheckInRadius\(\{ geofence: fence \}\)/)
    expect(setFence).not.toMatch(/fence\?\.type === "circle"/)
  })

  it("a ring still being drawn moves neither the pin nor the address (React review, SCRUM-353b)", () => {
    const onFence = src.slice(src.indexOf("function onFenceChange("), src.indexOf("function inherit("))
    expect(onFence).toMatch(/if \(fence\.type === "polygon" && fence\.ring\.length < 3\) return\s*\n\s*const centre = fenceCentre\(fence\)/)
  })

  it("closing Adjust on an unfinished outline puts the area and its citation back (React review, SCRUM-353b)", () => {
    const adjust = src.slice(src.indexOf("function adjust("), src.indexOf("function adjust(") + 400)
    expect(adjust).toMatch(/if \(open\) beforeAdjust\.current = \{ fence: geofence, source: areaSource \}/)
    expect(adjust).toMatch(/ring\.length < 3\) \{\s*setFence\(beforeAdjust\.current\.fence\)\s*setAreaSource\(beforeAdjust\.current\.source\)/)
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    expect(editor).toMatch(/if \(!editable && drawing\) setDrawing\(false\)/)
  })

  it("the buffer choice waits for a linked venue to load, and the slider never ends below the venue's buffer (React review)", () => {
    expect(src).toMatch(/fence=\{venuePending \? null : geofence\}/)
    const controls = readFileSync(join(__dirname, "../components/event-form/area-controls.tsx"), "utf8")
    expect(controls).toMatch(/Math\.max\(SLIDER_MAX_M, base, fence\?\.buffer \?\? 0\)/)
  })

  it("says an outline was cleared only when it was drawn by hand or saved, not when one picked place replaces another", () => {
    expect(src.match(/setMovedKm\(lostDrawing\(areaSource\) \? moved : null\)/g)).toHaveLength(2)
    expect(src).toMatch(/const lostDrawing = \(source: AreaSource \| null\) => source === "drawn" \|\| source === null/)
  })

  it("\"Use it\" applies only if nothing was picked meanwhile, and no lookup lands after the section goes (React review, SCRUM-353c)", () => {
    const take = src.slice(src.indexOf("function takeListed("), src.indexOf("function keepSeparate("))
    expect(take).toMatch(/const asked = \+\+nearbySeq\.current/)
    expect(take).toMatch(/if \(asked !== nearbySeq\.current\) return\s*\n\s*if \(v\) inherit\(v\)/)
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{\s*footprintSeq\.current\+\+\s*nearbySeq\.current\+\+/)
  })

  it("a second click cannot list the place twice (React review, SCRUM-353c)", () => {
    const form = readFileSync(join(__dirname, "../components/event-form.tsx"), "utf8")
    expect(form).toMatch(/const submit = async \(data: EventFormValues\) => \{\s*if \(submitting\.current\) return\s*submitting\.current = true/)
    expect(form).toMatch(/finally \{\s*submitting\.current = false/)
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
  it("a search that brings the place's own outline draws it, the pin at its centre (SCRUM-351)", () => {
    // Nominatim returns a stadium's or a palace's outline with the hit; a bar is a pin.
    const search = readFileSync(join(__dirname, "../components/event-form/where-search.tsx"), "utf8")
    const pick = search.slice(search.indexOf("function pick("), search.indexOf("if (selected)"))
    expect(pick).toMatch(/outline: outlineFromGeoJson\(hit\.geojson\)/)
    const moveTo = src.slice(src.indexOf("function moveTo("), src.indexOf("function onFenceChange("))
    expect(moveTo).toMatch(/if \(location\.outline\)/)
    expect(moveTo).toMatch(/type: "polygon", ring: location\.outline/)
    expect(moveTo).toMatch(/fenceCentre\(/)
  })

  it("the building outline comes from /api/footprint, never Overpass from the browser (SCRUM-351)", () => {
    // Direct, with no User-Agent, was against OSM's usage policy; and "Couldn't
    // reach OpenStreetMap" was said for a busy server and for no building alike.
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    const imp = editor.slice(editor.indexOf("const importFootprint"), editor.indexOf("/* --------------------------------------------------------------- view --- */"))
    expect(imp).toMatch(/fetch\(`\/api\/footprint\?lat=/)
    expect(imp).not.toMatch(/overpass-api\.de/)
    expect(imp).toMatch(/busy/i)
  })

  it("a pick cancels a pending search, so 'Searching…' cannot stick", () => {
    const search = readFileSync(join(__dirname, "../components/event-form/where-search.tsx"), "utf8")
    const pick = search.slice(search.indexOf("function pick("), search.indexOf("if (selected)"))
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

  it("frames an imported outline, and puts nothing over the zoom control", () => {
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    const imp = editor.slice(editor.indexOf("const importFootprint"), editor.indexOf("/* --------------------------------------------------------------- view --- */"))
    expect(imp).toMatch(/mapRef\.current\?\.fitBounds\(ring/)
    // The search sat top-left on the map, first under the zoom control, then
    // beside it; it lives above the map now (SCRUM-353) and the slot is gone.
    expect(editor).not.toMatch(/overlay/)
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
