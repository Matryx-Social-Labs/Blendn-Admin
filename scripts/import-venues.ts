import { readFileSync } from "node:fs"
import type { venue_type } from "@prisma/client"

import { auditInTx } from "../lib/audit-log"
import { parseCsvRows } from "../lib/csv"
import { closeDb, db } from "../lib/db"
import { haversineDistanceMeters } from "../lib/geo"
import { isValidLatLng, type Geofence } from "../lib/geofence"
import { DUPLICATE_RADIUS_M, defaultVenueFence, nearbyVenues } from "../lib/venue-rules"
import { VENUE_TYPE_GROUPS } from "../lib/venue-types"
import { fenceFromOsm, lookup } from "./enrich-venues-from-osm"

/**
 * Founder seeding: venues from a CSV (product-completion plan v2, §3).
 *
 * Every venue is live from day one, so the founders list the places they know
 * before any owner arrives. Each row meets the rules a venue typed into the
 * dashboard meets (`lib/venue-rules.ts`, shared with `createVenue`):
 *
 *   - **refused within 100 m of a listed venue** (or inside its outline), and
 *     within 100 m of an earlier row in the same file
 *   - **an area sized for its type** when nobody drew one
 *   - **unclaimed**, as an admin's venue is: no owner, no creating organisation.
 *     The owner claims it later at `/claim/venue/<id>`, and a person reviews it.
 *
 * With `--osm`, a venue whose own building OSM knows by name gets that
 * footprint instead of the circle — `scripts/enrich-venues-from-osm.ts`'s
 * lookup, five seconds apart, because Overpass throttles anonymous callers.
 *
 * ## The file
 *
 * A header row, any column order, names case-insensitive:
 *
 *   name, address, lat, lng, maps_url, type, city
 *
 * `name` and `city` are required. Coordinates are `lat` + `lng`, or a Google
 * Maps link in `maps_url` (a place link, a `?q=lat,lng` link, or a
 * maps.app.goo.gl share link, which is followed to find its coordinates).
 * `type` is a venue type's value or its label ("pub_bar" or "Pub or bar");
 * blank leaves it unclassified. Quote any cell holding a comma.
 *
 * ## Running it
 *
 * A dry run by default: it prints every row (with where its coordinates came
 * from), every duplicate and every refusal, by the line it is on in the file,
 * and writes nothing.
 *
 * `--apply` is all-or-nothing. A file with any refused row writes nothing; so
 * does a failure part-way, because every footprint is worked out first and the
 * rows are written in one transaction. Re-running is safe: rows already
 * imported come back as duplicates.
 *
 *   DATABASE_URL=… npx tsx scripts/import-venues.ts venues.csv
 *   DATABASE_URL=… npx tsx scripts/import-venues.ts venues.csv --apply [--osm]
 *
 * Through `npx tsx`, not an npm script, on purpose: npm 11 takes `--apply`
 * given to `npm run` as its own option and drops it, which quietly turns a
 * write into a dry run. If you wrap it in one anyway, put `--` before the file.
 * The first line printed says which ran: `APPLY` or `DRY RUN`.
 */

const COLUMNS = ["name", "address", "lat", "lng", "maps_url", "type", "city"] as const
const FLAGS = new Set(["--apply", "--osm"])
/** Overpass's anonymous rate, the same pause the enrichment script keeps. */
const OSM_PAUSE_MS = 5000
const SHORT_LINK_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"])
/** google.com, google.co.in, maps.google.com and the like — not google.evil.com. */
const GOOGLE_MAPS_HOST = /^(www\.|maps\.)?google\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/

/** Where a row's coordinates came from — printed, so a map centre is never mistaken for a pin. */
export type CoordinateSource = "lat/lng" | "place pin" | "typed pair" | "map centre"

export interface VenueRow {
  /** The physical line the row starts on, for the operator to find it. */
  line: number
  name: string
  address: string | null
  city: string
  venueType: venue_type | null
  lat: number
  lng: number
  source: CoordinateSource
}

export type RowResult =
  | { ok: true; row: VenueRow }
  | { ok: false; line: number; name: string; reason: string }

const TYPE_BY_NAME = new Map(
  VENUE_TYPE_GROUPS.flatMap((g) =>
    g.types.flatMap((t) => [
      [t.value.toLowerCase(), t.value],
      [t.label.toLowerCase(), t.value],
    ])
  ) as [string, venue_type][]
)

/** A venue type's value or label, case-insensitive. Undefined when unknown. */
export function venueTypeFrom(text: string): venue_type | null | undefined {
  const key = text.trim().toLowerCase()
  if (!key) return null
  return TYPE_BY_NAME.get(key)
}

const PAIR = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/
const CENTRE = /^@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    // A bare "%" in a place name: read it undecoded rather than abort the run.
    return text
  }
}

/**
 * Coordinates from a Google Maps link, without a network call.
 *
 * In order of trust: `!3d<lat>!4d<lng>` is the place's own pin; a `q`, `query`,
 * `ll` or `destination` parameter holding a pair is what someone typed; a path
 * segment starting `@lat,lng` is only where the map was centred when the link
 * was copied, so it is last — and only a segment that starts with it, never a
 * place name that happens to contain "@12,77". A link with none of these (a
 * search by name) is null: the row is refused, not guessed.
 */
export function coordinatesFromMapsUrl(raw: string): { lat: number; lng: number; source: CoordinateSource } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (!GOOGLE_MAPS_HOST.test(url.hostname) && !SHORT_LINK_HOSTS.has(url.hostname)) return null

  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(decoded(url.pathname))
  const typed = ["q", "query", "ll", "destination"]
    .map((k) => PAIR.exec(url.searchParams.get(k) ?? ""))
    .find(Boolean)
  const centre = url.pathname
    .split("/")
    .map((segment) => CENTRE.exec(decoded(segment)))
    .find(Boolean)
  const [match, source]: [RegExpExecArray | null | undefined, CoordinateSource] = pin
    ? [pin, "place pin"]
    : typed
      ? [typed, "typed pair"]
      : [centre, "map centre"]
  if (!match) return null

  const lat = Number(match[1])
  const lng = Number(match[2])
  return isValidLatLng(lat, lng) ? { lat, lng, source } : null
}

/**
 * A share link (maps.app.goo.gl) says nothing until followed. One hop, by
 * HEAD, never following the redirect: the Location is read, and used only if
 * it is a Google Maps page. Nothing else on the internet is fetched.
 */
export async function followShortLink(raw: string): Promise<string> {
  const url = new URL(raw.trim())
  if (url.protocol !== "https:" || !SHORT_LINK_HOSTS.has(url.hostname)) return raw
  const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) })
  await res.body?.cancel()
  const location = res.headers.get("location")
  if (!location) throw new Error(`no redirect from the share link (HTTP ${res.status})`)
  const target = new URL(location, url)
  if (target.protocol !== "https:" || !GOOGLE_MAPS_HOST.test(target.hostname)) {
    throw new Error(`the share link leads to ${target.hostname}, not Google Maps`)
  }
  return target.toString()
}

/**
 * One CSV row, checked. Coordinates come from `lat`/`lng`, else the maps link.
 * `resolve` follows a share link; injected so the parse is testable offline.
 */
export async function readRow(
  cells: Record<string, string>,
  line: number,
  resolve: (url: string) => Promise<string> = followShortLink
): Promise<RowResult> {
  const name = (cells.name ?? "").trim()
  const refuse = (reason: string): RowResult => ({ ok: false, line, name, reason })
  if (name.length < 2) return refuse("no name")
  const city = (cells.city ?? "").trim()
  if (!city) return refuse("no city")

  const venueType = venueTypeFrom(cells.type ?? "")
  if (venueType === undefined) return refuse(`unknown type "${cells.type}"`)

  let lat = Number.NaN
  let lng = Number.NaN
  let source: CoordinateSource = "lat/lng"
  if ((cells.lat ?? "").trim() && (cells.lng ?? "").trim()) {
    lat = Number(cells.lat)
    lng = Number(cells.lng)
  } else if ((cells.maps_url ?? "").trim()) {
    let found = coordinatesFromMapsUrl(cells.maps_url)
    if (!found) {
      try {
        found = coordinatesFromMapsUrl(await resolve(cells.maps_url))
      } catch (error) {
        return refuse(`maps link did not open (${error instanceof Error ? error.message : error})`)
      }
    }
    if (!found) return refuse("no coordinates in the maps link — paste lat and lng")
    ;({ lat, lng, source } = found)
  }
  if (!isValidLatLng(lat, lng)) return refuse("no valid lat/lng or maps link")

  const address = (cells.address ?? "").trim() || null
  return { ok: true, row: { line, name, address, city, venueType, lat, lng, source } }
}

/** The header row, mapped to column names. Refuses a file missing `name`. */
export function columnsOf(header: string[]): Map<number, string> {
  if (header.length === 1 && header[0]!.includes(";")) {
    throw new Error('the columns are separated by ";" — save the file as comma-separated (CSV UTF-8)')
  }
  const at = new Map<number, string>()
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase()
    if ((COLUMNS as readonly string[]).includes(key)) at.set(i, key)
  })
  if (![...at.values()].includes("name")) throw new Error(`no "name" column; expected ${COLUMNS.join(", ")}`)
  return at
}

/** Whether an earlier row in the same file is within the duplicate radius. */
export function duplicateInFile(row: VenueRow, earlier: VenueRow[]): { of: VenueRow; metres: number } | null {
  for (const other of earlier) {
    const metres = Math.round(haversineDistanceMeters(row.lat, row.lng, other.lat, other.lng))
    if (metres <= DUPLICATE_RADIUS_M) return { of: other, metres }
  }
  return null
}

async function footprint(row: VenueRow, osm: boolean): Promise<{ fence: Geofence; source: string }> {
  if (osm) {
    try {
      const fence = fenceFromOsm(await lookup(row.lat, row.lng, row.name))
      if (fence) return { fence, source: "osm outline" }
    } catch (error) {
      console.log(`  WARN  line ${row.line} ${row.name}: Overpass failed (${error instanceof Error ? error.message : error}); circle`)
    } finally {
      // Paced whatever the answer: a failure is still a request Overpass counted.
      await new Promise((r) => setTimeout(r, OSM_PAUSE_MS))
    }
  }
  return { fence: defaultVenueFence(row.lat, row.lng, row.venueType), source: "circle by type" }
}

/** Every row checked against the file and the database, printed, and the ones to write returned. */
async function plan(text: string): Promise<{ accepted: VenueRow[]; refused: number; duplicates: number; total: number }> {
  const [header, ...body] = parseCsvRows(text)
  if (!header) throw new Error("the file is empty")
  const columns = columnsOf(header.cells)
  const nameAt = [...columns].find(([, key]) => key === "name")?.[0] ?? 0

  const accepted: VenueRow[] = []
  let refused = 0
  let duplicates = 0
  for (const { line, cells } of body) {
    if (cells.length !== header.cells.length) {
      console.log(`  SKIP  line ${line} ${(cells[nameAt] ?? "").trim()}: ${cells.length} cells, the header has ${header.cells.length}`)
      refused++
      continue
    }
    const named = Object.fromEntries([...columns].map(([at, key]) => [key, cells[at] ?? ""]))
    const result = await readRow(named, line)
    if (!result.ok) {
      console.log(`  SKIP  line ${result.line} ${result.name}: ${result.reason}`)
      refused++
      continue
    }
    const row = result.row
    const label = row.name.slice(0, 34).padEnd(34)

    const listed = (await nearbyVenues(row.lat, row.lng, true))[0]
    const inFile = duplicateInFile(row, accepted)
    if (listed) {
      console.log(`  DUP   line ${row.line} ${label} ${listed.name} is listed ${listed.distanceMetres} m away (${listed.id})`)
      duplicates++
      continue
    }
    if (inFile) {
      console.log(`  DUP   line ${row.line} ${label} line ${inFile.of.line} (${inFile.of.name}) is ${inFile.metres} m away`)
      duplicates++
      continue
    }
    accepted.push(row)
    console.log(
      `  NEW   line ${row.line} ${label} ${(row.venueType ?? "unclassified").padEnd(18)} ${row.city} ${row.lat.toFixed(5)},${row.lng.toFixed(5)} (${row.source})`
    )
  }
  return { accepted, refused, duplicates, total: body.length }
}

async function main() {
  const args = process.argv.slice(2)
  const file = args.find((a) => !a.startsWith("--"))
  const unknown = args.filter((a) => a.startsWith("--") && !FLAGS.has(a))
  if (!file || unknown.length > 0 || args.filter((a) => !a.startsWith("--")).length !== 1) {
    console.error("Usage: npx tsx scripts/import-venues.ts <venues.csv> [--apply] [--osm]")
    process.exitCode = 1
    return
  }
  const apply = args.includes("--apply")
  const osm = args.includes("--osm")
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set")

  console.log(`${apply ? "APPLY" : "DRY RUN"} · ${file} · database ${new URL(process.env.DATABASE_URL).host}\n`)
  const { accepted, refused, duplicates, total } = await plan(readFileSync(file, "utf8"))

  console.log(`\n${total} row(s): ${accepted.length} new, ${duplicates} duplicate(s), ${refused} refused`)
  if (!apply) {
    console.log("Dry run: nothing written. Re-run with --apply to write.")
    return
  }
  if (refused > 0) {
    console.log("Not applied: fix the refused rows first. Nothing was written.")
    process.exitCode = 1
    return
  }

  // Footprints first (the slow, fallible part), so the write is one transaction.
  const writes: { row: VenueRow; fence: Geofence; source: string }[] = []
  for (const row of accepted) writes.push({ row, ...(await footprint(row, osm)) })

  const written = await db.$transaction(
    async (tx) => {
      const ids: string[] = []
      for (const { row, fence } of writes) {
        const created = await tx.venues.create({
          data: {
            name: row.name,
            venue_type: row.venueType,
            address: row.address,
            city: row.city,
            latitude: row.lat,
            longitude: row.lng,
            geofence: fence as object,
            // Unclaimed, as an admin's venue is (`createVenue`).
            owner_org_id: null,
            claimed_at: null,
            created_by: null,
            created_by_org_id: null,
          },
          select: { id: true },
        })
        await auditInTx(tx, {
          action: "venue.created",
          resource: "venue",
          resourceId: created.id,
          details: { name: row.name, venueType: row.venueType, claimed: false, source: "scripts/import-venues.ts", line: row.line },
        })
        ids.push(created.id)
      }
      return ids
    },
    { timeout: 120_000 }
  )
  writes.forEach(({ row, source }, i) => console.log(`  WROTE line ${row.line} ${row.name} → ${written[i]} (${source})`))
  console.log(`Applied: ${written.length} written in one transaction.`)
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    })
    .finally(() => closeDb())
}
