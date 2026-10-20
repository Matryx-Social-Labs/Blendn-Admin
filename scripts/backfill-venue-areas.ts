import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { parseCsvRows } from "../lib/csv"
import { closeDb, db } from "../lib/db"
import { areaSlug } from "../lib/venue-area"

/**
 * Sets `venues.area` / `venues.area_slug` from Overture's division polygons.
 * Three steps, because the polygons live in a dataset DuckDB reads and the
 * venues live in the database (the same split `scripts/places` has):
 *
 *   DATABASE_URL=… npx tsx scripts/backfill-venue-areas.ts export
 *   duckdb < scripts/places/areas.sql
 *   DATABASE_URL=… npx tsx scripts/backfill-venue-areas.ts apply            # dry run: prints the counts
 *   DATABASE_URL=… npx tsx scripts/backfill-venue-areas.ts apply --apply
 *
 * `export` writes `scripts/places/out/venue-points.csv` (id, lat, lng) for every
 * listed venue with a position and no area yet. `apply` reads
 * `scripts/places/out/venue-areas.csv` (id, area) and writes only venues whose
 * area is still null, so a re-run changes nothing and a hand-set area is never
 * overwritten. A venue the polygons do not hold has no row there and stays null.
 *
 * Through `npx tsx`, not an npm script: npm 11 eats `--apply`. The first line
 * printed says which ran, `APPLY` or `DRY RUN`.
 */

const POINTS = "scripts/places/out/venue-points.csv"
const AREAS = "scripts/places/out/venue-areas.csv"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AreaGroup {
  area: string
  slug: string
  ids: string[]
}

/** The `id, area` file as one group per area. Throws, naming the line, on a row it cannot trust. */
export function readAreas(text: string): AreaGroup[] {
  const [header, ...body] = parseCsvRows(text)
  const at = (name: string) => header?.cells.map((c) => c.trim().toLowerCase()).indexOf(name) ?? -1
  const idAt = at("id")
  const areaAt = at("area")
  if (idAt < 0 || areaAt < 0) throw new Error("the file needs an id and an area column")
  const groups = new Map<string, AreaGroup>()
  const seen = new Set<string>()
  for (const { line, cells } of body) {
    const id = (cells[idAt] ?? "").trim().toLowerCase()
    const area = (cells[areaAt] ?? "").trim()
    if (!UUID.test(id)) throw new Error(`line ${line}: "${id}" is not a venue id`)
    if (seen.has(id)) throw new Error(`line ${line}: ${id} is listed twice`)
    seen.add(id)
    const slug = areaSlug(area)
    if (!slug) throw new Error(`line ${line}: "${area}" has no letters or digits to make a slug of`)
    // The slug is the key: two spellings of one slug are one area, under the first spelling.
    const group = groups.get(slug) ?? { area, slug, ids: [] }
    group.ids.push(id)
    groups.set(slug, group)
  }
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length || (a.slug < b.slug ? -1 : 1))
}

async function exportPoints() {
  const venues = await db.venues.findMany({
    where: { deleted_at: null, area_slug: null, latitude: { not: null }, longitude: { not: null } },
    select: { id: true, latitude: true, longitude: true },
    orderBy: { id: "asc" },
  })
  mkdirSync(dirname(POINTS), { recursive: true })
  // Ids and numbers only: nothing to quote. LF, not toCsv's CRLF, which DuckDB's sniffer refuses.
  writeFileSync(POINTS, ["id,lat,lng", ...venues.map((v) => `${v.id},${v.latitude},${v.longitude}`)].join("\n") + "\n")
  console.log(`Wrote ${venues.length} venues to ${POINTS}. Next: duckdb < scripts/places/areas.sql`)
}

async function apply(write: boolean) {
  console.log(write ? "APPLY" : "DRY RUN")
  const groups = readAreas(readFileSync(AREAS, "utf8"))
  let changed = 0
  // One transaction: a failure part-way leaves no half-labelled city.
  await db.$transaction(
    async (tx) => {
      for (const g of groups) {
        const n = write
          ? (await tx.venues.updateMany({ where: { id: { in: g.ids }, area_slug: null }, data: { area: g.area, area_slug: g.slug } })).count
          : await tx.venues.count({ where: { id: { in: g.ids }, area_slug: null } })
        changed += n
        console.log(`  ${String(n).padStart(5)}  ${g.area} (${g.slug})`)
      }
    },
    { timeout: 120_000 }
  )
  console.log(`${write ? "Set" : "Would set"} ${changed} venues across ${groups.length} areas.`)
}

async function main() {
  const [mode, ...flags] = process.argv.slice(2)
  if (mode === "export") return exportPoints()
  if (mode === "apply") return apply(flags.includes("--apply"))
  throw new Error("usage: backfill-venue-areas.ts export | apply [--apply]")
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    })
    .finally(() => closeDb())
}
