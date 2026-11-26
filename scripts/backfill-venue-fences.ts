import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import { Prisma, type PrismaClient, type venue_type } from "@prisma/client"

import { buildCatalogue, cityFor } from "../lib/cities"
import { closeDb, db } from "../lib/db"
import { DEFAULT_BUFFER_M, pointInPolygon, validateGeofence, type Geofence, type LatLng } from "../lib/geofence"
import { outlineFromGeoJson, pickShape } from "../lib/outline"

/**
 * A seeded, unclaimed venue's check-in area becomes the Overture building its pin is in (SCRUM-1150), so the
 * building the home map lights is the building the door checks. Four steps, the `backfill-venue-areas.ts` split:
 *
 *   DATABASE_URL=… npx tsx scripts/backfill-venue-fences.ts export <dir>
 *   FENCES_DIR=<dir> CITY=bengaluru duckdb < scripts/places/buildings.sql       # once per city
 *   npx tsx scripts/backfill-venue-fences.ts pick <dir>                          # no database: fences.json + report.md
 *   DATABASE_URL=… npx tsx scripts/backfill-venue-fences.ts apply <dir>/fences.json [--apply] [--exclude <id>[,<id>]]
 *   DATABASE_URL=… npx tsx scripts/backfill-venue-fences.ts --revert <rollback file> [--apply]
 *
 * `<dir>` is outside the repo. `fences.json` is the dry run's output and the apply's input, so an apply never needs
 * Overture to still serve the release (it keeps only its last two). `apply` without `--apply` is the dry run.
 *
 * **Scope** is the provenance check: a dataset venue (`source` `overture:…`), unclaimed, not deleted, with no fence or
 * a circle. No column and no Json key says "backfilled" (`validateGeofence` would drop a key on the next save). The
 * scope is repeated in the UPDATE, with "the fence is still the one exported", so a venue claimed or edited after the
 * export is skipped and a second apply changes nothing. Every write and every dry run writes a rollback file — venue
 * id, the fence before, the fence written — that `--revert` puts back where the fence is still the one written.
 *
 * Through `npx tsx`, not an npm script: npm 11 eats `--apply`. The first line printed says which ran.
 */

/** The pilot's venue (2026-11-28). An apply refuses a database that holds it unless it is excluded by name. */
export const PILOT_VENUE_ID = "0fbaa05a-2d36-45fc-8066-82742636044c"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A café or a bar in a building this big is in the mall, not the building: it keeps its circle. */
const MAX_SMALL_VENUE_M2 = 20_000
/** The "Food & drink" and "Nightlife" groups of `lib/venue-types.ts`. */
const SMALL_VENUE_TYPES = new Set<venue_type>([
  "restaurant", "pub_bar", "brewery", "cafe", "lounge_rooftop", "nightclub", "live_music_venue",
])
/** Rows per UPDATE, each its own short transaction. */
const BATCH = 200

const SCOPE = Prisma.sql`v.deleted_at IS NULL AND v.source LIKE 'overture:%' AND v.claimed_at IS NULL
  AND (v.geofence IS NULL OR v.geofence->>'type' = 'circle')`

/** One Overture building near a venue, as `buildings.sql` writes it. `geometry` is GeoJSON, [lng, lat]. */
export interface Candidate {
  building: string
  dataset: string
  cls: string | null
  geometry: unknown
}

export type Pick =
  | { ok: true; fence: Geofence; building: string; dataset: string; how: "contained" | "nearest" }
  | { ok: false; reason: "none" | "unusable_ring" | "too_big_for_type" }

export interface ExportedVenue {
  id: string
  lat: number
  lng: number
  type: venue_type | null
  city: string
  /** The fence at export; the apply writes only while it is still this. */
  was: unknown
}

export interface FenceRow {
  id: string
  was: unknown
  fence: Geofence
  building: string
  dataset: string
  how: "contained" | "nearest"
}

export interface FencesFile {
  release: string
  rows: FenceRow[]
}

export interface RollbackRow {
  id: string
  previous: unknown
  written: unknown
}

export interface RollbackFile {
  release: string
  mode: "dry-run" | "apply"
  rows: RollbackRow[]
}

/** Square metres of a [lat, lng] ring, flat-earth at its own latitude: a building is small enough. */
function areaM2(ring: [number, number][]): number {
  const mLat = 111_320
  const mLng = mLat * Math.cos((ring[0][0] * Math.PI) / 180)
  let twice = 0
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i], ring[(i + 1) % ring.length]]
    twice += a[1] * mLng * b[0] * mLat - b[1] * mLng * a[0] * mLat
  }
  return Math.abs(twice) / 2
}

/**
 * The venue's fence from the buildings near it: `pickShape` (pickBuilding's rule) over the rings
 * `outlineFromGeoJson` can use — largest part, outer ring, at most MAX_RING points, never self-intersecting — then
 * the size rule for a café or a bar, then `validateGeofence` with the default buffer.
 */
export function fenceFromCandidates(pin: LatLng, type: venue_type | null, candidates: Candidate[]): Pick {
  const shapes = candidates.flatMap((c) => {
    const ring = outlineFromGeoJson(c.geometry)
    return ring ? [{ ...c, ring, stadium: c.cls === "stadium" }] : []
  })
  const picked = pickShape(shapes, pin)
  // ponytail: an unusable ring is named only when nothing else was picked; a usable neighbour can stand in for it,
  // as it does in pickBuilding.
  if (!picked) return { ok: false, reason: shapes.length < candidates.length ? "unusable_ring" : "none" }
  if (type && SMALL_VENUE_TYPES.has(type) && areaM2(picked.ring) > MAX_SMALL_VENUE_M2) {
    return { ok: false, reason: "too_big_for_type" }
  }
  const valid = validateGeofence({ type: "polygon", ring: picked.ring, buffer: DEFAULT_BUFFER_M })
  if (!valid.ok) return { ok: false, reason: "unusable_ring" }
  return {
    ok: true,
    fence: valid.fence,
    building: picked.building,
    dataset: picked.dataset,
    how: pointInPolygon(pin, picked.ring) ? "contained" : "nearest",
  }
}

/** Every `--exclude` value, comma lists included. Throws on anything that is not a venue id. */
export function readExclude(args: string[]): Set<string> {
  const ids = new Set<string>()
  args.forEach((arg, i) => {
    if (arg !== "--exclude") return
    for (const id of (args[i + 1] ?? "").split(",")) {
      if (!UUID.test(id.trim())) throw new Error(`--exclude: "${id}" is not a venue id`)
      ids.add(id.trim().toLowerCase())
    }
  })
  return ids
}

/** The venues in scope with a position: ids, points, types and city slugs only. */
export async function exportVenues(client: PrismaClient): Promise<ExportedVenue[]> {
  const [markets, cities, rows] = await Promise.all([
    client.markets.findMany(),
    client.cities.findMany(),
    client.$queryRaw<(Omit<ExportedVenue, "city"> & { city: string | null })[]>`
      SELECT v.id::text AS id, v.latitude AS lat, v.longitude AS lng, v.venue_type::text AS type, v.city,
             v.geofence AS was
      FROM venues v
      WHERE ${SCOPE} AND v.latitude IS NOT NULL AND v.longitude IS NOT NULL
      ORDER BY v.id`,
  ])
  const catalogue = buildCatalogue(markets, cities)
  return rows.map((v) => ({ ...v, city: cityFor(catalogue, v.city)?.slug ?? "elsewhere" }))
}

async function batchOf(client: PrismaClient, rows: FenceRow[], write: boolean): Promise<RollbackRow[]> {
  const json = JSON.stringify(rows.map(({ id, was, fence }) => ({ id, was, fence })))
  if (!write) {
    return client.$queryRaw<RollbackRow[]>`
      SELECT v.id::text AS id, v.geofence AS previous, x.fence AS written
      FROM jsonb_to_recordset(${json}::jsonb) AS x(id uuid, was jsonb, fence jsonb)
      JOIN venues v ON v.id = x.id
      WHERE ${SCOPE} AND v.geofence IS NOT DISTINCT FROM x.was`
  }
  // One statement. Once it holds a row's lock Postgres re-checks the whole WHERE against the row's newest version, so a
  // venue claimed or edited after the export drops out here instead of being overwritten. `previous` is `was`: the
  // WHERE says the two are the same.
  const [, written] = await client.$transaction([
    client.$executeRaw`SET LOCAL lock_timeout = '5s'`,
    client.$queryRaw<RollbackRow[]>`
      UPDATE venues v SET geofence = x.fence, updated_at = now()
      FROM jsonb_to_recordset(${json}::jsonb) AS x(id uuid, was jsonb, fence jsonb)
      WHERE v.id = x.id AND ${SCOPE} AND v.geofence IS NOT DISTINCT FROM x.was
      RETURNING v.id::text AS id, x.was AS previous, x.fence AS written`,
  ])
  return written
}

/** Whole or not at all: a run killed mid-write must not leave half a rollback file. */
function saveRollback(path: string, rollback: RollbackFile) {
  writeFileSync(`${path}.tmp`, JSON.stringify(rollback, null, 1) + "\n")
  renameSync(`${path}.tmp`, path)
}

/**
 * Writes (or, dry, counts) the file's fences, in batches. Before each batch the rollback file already lists the batch
 * as it would be written, so a run killed between a commit and the next save still holds every row it changed (a row
 * it did not change is harmless there: `--revert` skips a venue whose fence is not the one written). After the batch
 * the file is narrowed to the rows that changed.
 */
export async function applyFences(
  client: PrismaClient,
  file: FencesFile,
  opts: { write: boolean; exclude: Set<string>; rollbackPath: string; batch?: number }
): Promise<RollbackRow[]> {
  if (opts.write && !opts.exclude.has(PILOT_VENUE_ID)) {
    if (await client.venues.findUnique({ where: { id: PILOT_VENUE_ID }, select: { id: true } })) {
      throw new Error(`This database holds the pilot venue. Run again with --exclude ${PILOT_VENUE_ID}.`)
    }
  }
  // The file sits on disk until after the pilot: nothing in it is written unless the editor would save it.
  for (const r of file.rows) {
    if (!UUID.test(r.id) || !("was" in r) || r.fence?.type !== "polygon" || !validateGeofence(r.fence).ok) {
      throw new Error(`${r.id}: not a venue id, its fence at export and a valid outline; nothing written`)
    }
  }
  const rows = file.rows.filter((r) => !opts.exclude.has(r.id.toLowerCase()))
  const mode = opts.write ? "apply" : "dry-run"
  const done: RollbackRow[] = []
  saveRollback(opts.rollbackPath, { release: file.release, mode, rows: done })
  const size = opts.batch ?? BATCH
  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size)
    if (opts.write) {
      const intended = batch.map((r) => ({ id: r.id, previous: r.was, written: r.fence }))
      saveRollback(opts.rollbackPath, { release: file.release, mode, rows: [...done, ...intended] })
    }
    done.push(...(await batchOf(client, batch, opts.write)))
    saveRollback(opts.rollbackPath, { release: file.release, mode, rows: done })
  }
  return done
}

/** Puts back each row's previous fence where the venue still has the fence the apply wrote. Returns those ids. */
export async function revertFences(client: PrismaClient, file: RollbackFile, opts: { write: boolean }): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < file.rows.length; i += BATCH) {
    const json = JSON.stringify(file.rows.slice(i, i + BATCH))
    const rows = opts.write
      ? (
          await client.$transaction([
            client.$executeRaw`SET LOCAL lock_timeout = '5s'`,
            client.$queryRaw<{ id: string }[]>`
              UPDATE venues v SET geofence = x.previous, updated_at = now()
              FROM jsonb_to_recordset(${json}::jsonb) AS x(id uuid, previous jsonb, written jsonb)
              WHERE v.id = x.id AND v.geofence = x.written
              RETURNING v.id::text AS id`,
          ])
        )[1]
      : await client.$queryRaw<{ id: string }[]>`
          SELECT v.id::text AS id
          FROM jsonb_to_recordset(${json}::jsonb) AS x(id uuid, previous jsonb, written jsonb)
          JOIN venues v ON v.id = x.id
          WHERE v.geofence = x.written`
    ids.push(...rows.map((r) => r.id))
  }
  return ids.sort()
}

const readNdjson = <T>(path: string): T[] =>
  readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T)

/** A directory outside this checkout: the files carry every seeded venue's point. */
export function outsideRepo(dir: string | undefined): string {
  if (!dir) throw new Error("name a directory outside the repo")
  const repo = realpathSync(resolve(__dirname, ".."))
  const inside = (path: string) => !relative(repo, path).startsWith("..")
  if (inside(resolve(dir))) throw new Error(`${resolve(dir)} is inside the repo`)
  mkdirSync(dir, { recursive: true })
  const abs = realpathSync(dir) // and not through a symlink into it
  if (inside(abs)) throw new Error(`${abs} is inside the repo`)
  return abs
}

async function exportStep(dir: string) {
  const venues = await exportVenues(db)
  writeFileSync(join(dir, "venues.ndjson"), venues.map((v) => JSON.stringify(v)).join("\n") + "\n")
  const byCity = new Map<string, number>()
  for (const v of venues) byCity.set(v.city, (byCity.get(v.city) ?? 0) + 1)
  console.log(`Wrote ${venues.length} venues in scope to ${dir}/venues.ndjson`)
  for (const [city, n] of [...byCity].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${city}`)
  console.log(`Next, per city: FENCES_DIR=${dir} CITY=<slug> duckdb < scripts/places/buildings.sql`)
}

type Outcome = "contained" | "nearest" | "too_big_for_type" | "unusable_ring" | "none"
const OUTCOMES: Outcome[] = ["contained", "nearest", "too_big_for_type", "unusable_ring", "none"]

/** Counts only: no venue is named. */
function table(title: string, rows: Map<string, Map<string, number>>, columns: string[]): string {
  const head = `| ${title} | in scope | ${columns.join(" | ")} |\n|---|---|${columns.map(() => "---|").join("")}`
  const body = [...rows]
    .sort((a, b) => (b[1].get("in scope") ?? 0) - (a[1].get("in scope") ?? 0))
    .map(([k, m]) => `| ${k} | ${m.get("in scope") ?? 0} | ${columns.map((c) => m.get(c) ?? 0).join(" | ")} |`)
  return [head, ...body].join("\n")
}

function pickStep(dir: string) {
  const venues = readNdjson<ExportedVenue>(join(dir, "venues.ndjson"))
  const files = readdirSync(dir).filter((f) => /^candidates-[a-z0-9-]+\.ndjson$/.test(f))
  if (!files.length) throw new Error(`no candidates-<city>.ndjson in ${dir}: run buildings.sql first`)
  const joined = new Set(files.map((f) => f.slice("candidates-".length, -".ndjson".length)))
  const near = new Map<string, Candidate[]>()
  const releases = new Set<string>()
  for (const f of files) {
    for (const c of readNdjson<Candidate & { venue: string; release: string }>(join(dir, f))) {
      releases.add(c.release)
      near.set(c.venue, [...(near.get(c.venue) ?? []), c])
    }
  }
  if (releases.size > 1) throw new Error(`candidates from more than one release: ${[...releases].join(", ")}`)
  const release = [...releases][0] ?? "(no building near any venue)"

  const rows: FenceRow[] = []
  const byCity = new Map<string, Map<string, number>>()
  const byType = new Map<string, Map<string, number>>()
  const bump = (at: Map<string, Map<string, number>>, key: string, col: string) => {
    const m = at.get(key) ?? new Map<string, number>()
    m.set(col, (m.get(col) ?? 0) + 1)
    at.set(key, m)
  }
  for (const v of venues.filter((v) => joined.has(v.city))) {
    const pick = fenceFromCandidates({ lat: v.lat, lng: v.lng }, v.type, near.get(v.id) ?? [])
    const outcome: Outcome = pick.ok ? pick.how : pick.reason
    for (const col of ["in scope", outcome, ...(pick.ok ? [pick.dataset] : [])]) {
      bump(byCity, v.city, col)
      bump(byType, v.type ?? "(none)", col)
    }
    if (pick.ok) rows.push({ id: v.id, was: v.was, fence: pick.fence, building: pick.building, dataset: pick.dataset, how: pick.how })
  }
  const file: FencesFile = { release, rows }
  writeFileSync(join(dir, "fences.json"), JSON.stringify(file) + "\n")

  const datasets = [...new Set(rows.map((r) => r.dataset))].sort()
  const report = [
    `# 04a dry run: Overture building fences (SCRUM-1150)`,
    ``,
    `Release ${release}; ${new Date().toISOString()}; cities joined: ${[...joined].sort().join(", ")}.`,
    `${rows.length} venues would get a building of ${venues.filter((v) => joined.has(v.city)).length} in scope there.`,
    ``,
    `## By city`,
    table("city", byCity, OUTCOMES),
    ``,
    `## By venue type`,
    table("type", byType, OUTCOMES),
    ``,
    `## Matched, by source dataset`,
    table("city", byCity, datasets),
    ``,
  ].join("\n")
  writeFileSync(join(dir, "report.md"), report)
  console.log(report)
  console.log(`Wrote ${dir}/fences.json. Next: apply ${dir}/fences.json (a dry run until --apply).`)
}

async function applyStep(fencesPath: string, args: string[]) {
  const unknown = args.filter((a, i) => a.startsWith("--") && a !== "--apply" && a !== "--exclude" && args[i - 1] !== "--exclude")
  if (unknown.length) throw new Error(`unknown ${unknown.join(" ")}: only --apply and --exclude <id>`)
  const write = args.includes("--apply")
  console.log(write ? "APPLY" : "DRY RUN")
  const exclude = readExclude(args)
  const file = JSON.parse(readFileSync(fencesPath, "utf8")) as FencesFile
  const rollbackPath = join(outsideRepo(dirname(resolve(fencesPath))), `rollback-${write ? "apply" : "dry-run"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  const done = await applyFences(db, file, { write, exclude, rollbackPath })
  console.log(`${write ? "Wrote" : "Would write"} ${done.length} of ${file.rows.length} fences (release ${file.release}); excluded ${exclude.size}.`)
  console.log(`Rollback file: ${rollbackPath}`)
}

async function revertStep(path: string, write: boolean) {
  console.log(write ? "REVERT" : "REVERT DRY RUN")
  const file = JSON.parse(readFileSync(path, "utf8")) as RollbackFile
  const ids = await revertFences(db, file, { write })
  console.log(`${write ? "Restored" : "Would restore"} ${ids.length} of ${file.rows.length} venues (release ${file.release}).`)
}

async function main() {
  const [mode, arg, ...rest] = process.argv.slice(2)
  if (mode === "export") return exportStep(outsideRepo(arg))
  if (mode === "pick") return pickStep(outsideRepo(arg))
  if (mode === "apply" && arg) return applyStep(arg, rest)
  if (mode === "--revert" && arg) return revertStep(arg, rest.includes("--apply"))
  throw new Error(
    "usage: backfill-venue-fences.ts export <dir> | pick <dir> | apply <fences.json> [--apply] [--exclude <id>] | --revert <rollback.json> [--apply]"
  )
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    })
    .finally(() => closeDb())
}
