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

  it("keeps the pin readable for e2e/venue-pin.spec.ts", () => {
    expect(src).toMatch(/data-lat=\{initialLat \?\? ""\} data-lng=\{initialLng \?\? ""\}/)
  })

  it("does not describe a purple ring that no longer exists", () => {
    expect(src).not.toMatch(/purple/i)
  })

  it("rewrites the address for an outline moved to another place, not only a dragged circle", () => {
    const onFence = src.slice(src.indexOf("function onFenceChange("), src.indexOf("function inherit("))
    expect(onFence).toMatch(/moved < \(fence\.type === "circle" \? 10 : OUTLINE_KEEP_WITHIN_M\)/)
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

  it("a fence replaced from outside ends tracing, so a venue's outline does not take clicks as corners", () => {
    const editor = readFileSync(join(__dirname, "../components/geofence-editor.tsx"), "utf8")
    expect(editor).toMatch(/if \(fence\.type !== prevType\) \{\s*setPrevType\(fence\.type\)\s*if \(fence\.type !== "polygon"\) setDrawing\(false\)/)
  })
})
