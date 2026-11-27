import { readFileSync, readdirSync } from "fs"
import { join } from "path"

/**
 * Every map in the dashboard draws licensed tiles and credits them (SCRUM-1147).
 *
 * The check-in area editor's Satellite layer loaded Esri World Imagery with no
 * key, which Esri's terms allow only with an Esri product or an ArcGIS
 * subscription. It was removed, not replaced. And OSM's tile policy asks for a
 * credit that links to its copyright page: the editor said only
 * "© OpenStreetMap". e2e/where-street-map-trace.spec.ts drives the editor; this
 * holds every surface, the venue pages and the location picker included.
 */
const ROOT = join(__dirname, "..")

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
}

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
    for (const f of osm) expect([f.path, /href="https:\/\/www\.openstreetmap\.org\/copyright"/.test(f.src)]).toEqual([f.path, true])
  })
})
