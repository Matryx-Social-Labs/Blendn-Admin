import { readFileSync, readdirSync } from "fs"
import { join } from "path"

import { MAP_CREDIT } from "../lib/map-credit"

/**
 * Every map in the dashboard draws licensed tiles and credits them (SCRUM-1147).
 *
 * The check-in area editor's Satellite layer loaded Esri World Imagery with no
 * key, which Esri's terms allow only with an Esri product or an ArcGIS
 * subscription. It was removed, not replaced. And OSM's tile policy asks for a
 * credit that links to its copyright page: the editor said only
 * "© OpenStreetMap". e2e/where-street-map-trace.spec.ts drives the editor; this
 * holds every surface, the venue pages and the location picker included.
 *
 * The editor also draws venue outlines from Overture buildings (ODbL, OSM
 * inside; scripts/backfill-venue-fences.ts), and nothing records which fence
 * came from there, so every editor map carries Overture's line too, linked to
 * the page with each source's own credit (SCRUM-1317). It keeps one line on a
 * 340 px map by dropping Leaflet's own prefix.
 */
const ROOT = join(__dirname, "..")

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
}

const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

const files = ["app", "components", "lib"].flatMap(sources).map((path) => ({
  path: path.slice(ROOT.length + 1),
  src: readFileSync(path, "utf8"),
}))

describe("map tiles and their credits", () => {
  it("loads no Esri imagery anywhere", () => {
    expect(files.filter((f) => /arcgisonline|World_Imagery/i.test(f.src)).map((f) => f.path)).toEqual([])
  })

  it("links the OpenStreetMap credit to its copyright page wherever OSM tiles are drawn", () => {
    const osm = files.filter((f) => /tile\.openstreetmap\.org/.test(f.src))
    expect(osm.map((f) => f.path).sort()).toEqual(["components/geofence-editor.tsx", "components/location-picker.tsx"])
    // The editor's credit is lib/map-credit.ts's; it is held below.
    const credit = (f: { path: string; src: string }) => (/\bMAP_CREDIT\b/.test(f.src) ? read("lib/map-credit.ts") : f.src)
    for (const f of osm) expect([f.path, /href="https:\/\/www\.openstreetmap\.org\/copyright"/.test(credit(f))]).toEqual([f.path, true])
  })

  it("credits Overture Maps Foundation on the editor's map, linked to its attribution page, beside OpenStreetMap", () => {
    expect(MAP_CREDIT.replace(/<[^>]+>/g, "")).toBe("© OpenStreetMap contributors, Overture Maps Foundation")
    const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
    const links = [...MAP_CREDIT.matchAll(/(<a\s[^>]*>)([^<]*)<\/a>/g)].map(([, tag, text]) => ({
      text,
      href: attr(tag, "href"),
      target: attr(tag, "target"),
      rel: attr(tag, "rel"),
      label: attr(tag, "aria-label"),
    }))
    expect(links).toEqual([
      expect.objectContaining({ text: "OpenStreetMap", href: "https://www.openstreetmap.org/copyright" }),
      expect.objectContaining({ text: "Overture Maps Foundation", href: "https://docs.overturemaps.org/attribution/" }),
    ])
    // A new tab, because the map sits in an unsaved form; and a screen reader hears that.
    for (const l of links) {
      expect([l.text, l.target, l.rel]).toEqual([l.text, "_blank", "noopener noreferrer"])
      expect(l.label).toMatch(/\(opens in a new tab\)$/)
    }
  })

  it("the editor draws that credit, without Leaflet's prefix, so it stays one line beside the legend", () => {
    const editor = read("components/geofence-editor.tsx")
    expect(editor).toMatch(/attribution: MAP_CREDIT\b/)
    expect(editor).toMatch(/attributionControl\.setPrefix\(false\)/)
  })
})
