import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import type { venue_type } from "@prisma/client"

import { GEOFENCE_LIMITS, ringSelfIntersects, validateGeofence, type Geofence } from "../lib/geofence"
import { defaultExtentMetres, venueTypeFromOsm, venueTypeLabel } from "../lib/venue-types"

/**
 * Fill in venue type, check-in area and address from OpenStreetMap.
 *
 * A backfill created one venue per distinct `events.venue_name`, which got the
 * rows and the links right and left every descriptive column null: no
 * `venue_type`, no `geofence`, no address. Events inheriting from such a venue
 * inherit nothing, so the picker looks like it does not work.
 *
 * **The details are read, not invented.** For each venue this queries Overpass
 * at the venue's own coordinates and takes what the map actually says — the
 * building footprint, the amenity tag, the street and city. A made-up address
 * that looks plausible is worse than a blank one, because nobody goes back to
 * check it.
 *
 * Where OSM has nothing, the venue keeps a circle sized by its type rather than
 * a guessed polygon, and the address stays null.
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/enrich-venues-from-osm.ts            # dry run
 *   DATABASE_URL=... npx tsx scripts/enrich-venues-from-osm.ts --apply
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

const OVERPASS = "https://overpass-api.de/api/interpreter"
/**
 * Overpass returns 406 to an anonymous caller with no identifying agent, and
 * their usage policy asks for one. Same problem this repo's ROADMAP already
 * flags for Nominatim.
 */
const UA = "blendn-admin/venue-enrichment (https://blendn.app; ops@blendn.app)"
/**
 * Overpass throttles anonymous callers hard — 1.5s between queries earned a
 * wall of 429s. This is a one-off backfill, so slow is free.
 */
const PAUSE_MS = 5000
const RETRIES = 3

interface OsmHit {
  tags: Record<string, string>
  ring: [number, number][] | null
  distance: number
  /**
   * Whether OSM's name actually matches the venue's.
   *
   * Load-bearing. Without it, "The Obsidian Loft" — an invented venue in
   * Tribeca — matched a real café next door and was classified as a café, with
   * that café's footprint as its check-in area. An unnamed amenity near a pin
   * is evidence that *something* is there, not that it is this venue.
   */
  nameMatched: boolean
}

function spanOf(ring: [number, number][]): number {
  const lats = ring.map((p) => p[0])
  const lngs = ring.map((p) => p[1])
  return (Math.max(...lats) - Math.min(...lats)) * (Math.max(...lngs) - Math.min(...lngs))
}

/** Rough metres between two coordinates — only used to rank candidates. */
function roughMetres(a: [number, number], b: [number, number]): number {
  const dLat = (a[0] - b[0]) * 111_320
  const dLng = (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180)
  return Math.hypot(dLat, dLng)
}

function centroid(ring: [number, number][]): [number, number] {
  const lat = ring.reduce((s, p) => s + p[0], 0) / ring.length
  const lng = ring.reduce((s, p) => s + p[1], 0) / ring.length
  return [lat, lng]
}

/**
 * What OSM knows at this pin.
 *
 * Asks for named amenities and building ways nearby. A venue's own outline is
 * usually the largest thing at its coordinates — a kiosk inside a stadium is
 * not the stadium — so ties break on span, then on distance from the pin.
 */
async function lookup(lat: number, lng: number, name: string): Promise<OsmHit | null> {
  const query =
    `[out:json][timeout:25];(` +
    `way["building"](around:80,${lat},${lng});` +
    `way["leisure"="stadium"](around:300,${lat},${lng});` +
    `node["amenity"](around:60,${lat},${lng});` +
    `node["tourism"](around:60,${lat},${lng});` +
    `);out geom tags 30;`

  let res: Response | null = null
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    res = await fetch(OVERPASS, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        Accept: "application/json",
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: AbortSignal.timeout(40_000),
    })
    if (res.ok) break
    // 429 (throttled) and 504 (gateway busy) are both "come back later".
    if (res.status !== 429 && res.status !== 504) break
    await new Promise((r) => setTimeout(r, PAUSE_MS * (attempt + 2)))
  }
  if (!res || !res.ok) throw new Error(`Overpass ${res?.status ?? "no response"}`)

  const body = (await res.json()) as {
    elements?: {
      tags?: Record<string, string>
      geometry?: { lat: number; lon: number }[]
      lat?: number
      lon?: number
    }[]
  }

  const needle = name.toLowerCase()
  const candidates = (body.elements ?? []).map((e) => {
    const ring = (e.geometry ?? []).map((g) => [g.lat, g.lon] as [number, number])
    const point: [number, number] =
      ring.length > 0 ? centroid(ring) : [e.lat ?? lat, e.lon ?? lng]
    return {
      tags: e.tags ?? {},
      ring: ring.length >= 4 ? ring : null,
      distance: roughMetres([lat, lng], point),
      nameMatched: false,
    }
  })

  if (candidates.length === 0) return null

  // A name match is the strongest signal available — "Toit" at Toit's pin is
  // the right building even if a larger one sits next door.
  const named = candidates.filter((c) => {
    const n = (c.tags.name ?? "").toLowerCase()
    return n.length > 2 && (needle.includes(n) || n.includes(needle.split(" ")[0]))
  })
  const pool = (named.length > 0 ? named : candidates).map((c) => ({
    ...c,
    nameMatched: named.length > 0,
  }))

  // Prefer something that carries a usable type; then the largest footprint.
  const typed = pool.filter((c) => venueTypeFromOsm(c.tags) !== null)
  const best = (typed.length > 0 ? typed : pool).sort((a, b) => {
    const spanA = a.ring ? spanOf(a.ring) : 0
    const spanB = b.ring ? spanOf(b.ring) : 0
    if (spanA !== spanB) return spanB - spanA
    return a.distance - b.distance
  })[0]

  return best ?? null
}

/**
 * Type from the venue's own name, for places OSM has never heard of.
 *
 * Several of these venues are invented demo records — "The Umbra Kitchen",
 * "Void Gallery" — so no amount of map lookup will classify them. The name is
 * the only evidence there is, and it is real evidence: someone called it a
 * kitchen because it is one.
 *
 * Deliberately conservative. An unmatched name stays null rather than becoming
 * a confident wrong answer.
 */
/**
 * Venues I could check by hand.
 *
 * These are real places whose type is a matter of public fact, and the name
 * rules below get several of them wrong (ExCeL is a convention centre but has
 * no "centre" in its name; Golden Gai is a bar district). Keyed on the exact
 * stored name.
 *
 * Everything absent from this table falls through to the name rules, and an
 * unmatched name stays null rather than becoming a confident wrong answer.
 */
const KNOWN: Record<string, venue_type> = {
  "Sri Kanteerava Stadium": "stadium",
  "ExCeL London": "convention_centre",
  "Kraftwerk Berlin": "nightclub",
  "Koramangala Social": "pub_bar",
  "The Humming Tree": "live_music_venue",
  "Sunburn Union": "live_music_venue",
  "Toit Brewpub Warehouse": "brewery",
  "Macaw By Stories": "lounge_rooftop",
  "Golden Gai": "pub_bar",
  "Copacabana Beach": "beach_waterfront",
  "Mercado de San Miguel": "retail_mall",
  "Second Home": "coworking",
  "Table Mountain": "park_ground",
  // A historic quarter rather than a single building — open ground is the
  // closest honest answer, and its check-in area is deliberately generous.
  "Barri Gòtic": "park_ground",
  "The Sixth Sense Festival": "park_ground",
  "Al Marmoom Desert": "park_ground",
  "Bondi Pavilion": "community_hall",
  "Ce La Vi": "lounge_rooftop",

  // Invented demo venues. There is no fact to get wrong, and leaving them
  // unclassified would give the app nothing to render — so these are the
  // reading the name plainly supports.
  "The Neon Cathedral": "nightclub",

  // Deliberately absent: "Venue TBA" is a placeholder, not a place, and
  // "jniojbjobjbjbj" is keyboard mash from a test event. Both became venue
  // records because the backfill did not filter, and both should probably be
  // deleted rather than described. Classifying them would hide that.
}

function typeFromName(name: string): venue_type | null {
  const known = KNOWN[name.trim()]
  if (known) return known
  const n = name.toLowerCase()
  const rules: [RegExp, venue_type][] = [
    [/stadium|arena/, "stadium"],
    [/festival|grounds?\b/, "park_ground"],
    [/gallery/, "art_gallery"],
    [/museum/, "museum"],
    // Deliberately no "cathedral": in a venue name it is almost always
    // metaphorical ("The Neon Cathedral" is a club, not a church).
    [/\bchurch\b|\btemple\b|\bmosque\b|gurudwara/, "religious_venue"],
    [/kitchen|dining|restaurant|bistro|eatery/, "restaurant"],
    [/brewpub|brewery|taproom/, "brewery"],
    [/pub\b|bar\b|tavern/, "pub_bar"],
    [/caf[eé]|coffee/, "cafe"],
    [/club\b|nightclub|disco/, "nightclub"],
    [/loft|rooftop|terrace|lounge/, "lounge_rooftop"],
    [/studio/, "studio"],
    [/theatre|theater|auditorium/, "theatre"],
    [/cinema/, "cinema"],
    [/hotel|inn\b/, "hotel"],
    [/resort/, "resort"],
    [/beach|waterfront/, "beach_waterfront"],
    [/mountain|hill|peak|park\b|garden/, "park_ground"],
    [/market|mercado|bazaar/, "retail_mall"],
    [/hall\b|banquet/, "banquet_hall"],
    [/centre|center|expo|convention/, "convention_centre"],
    [/co-?working|workspace|second home/, "coworking"],
    [/warehouse/, "warehouse"],
  ]
  for (const [re, type] of rules) if (re.test(n)) return type
  return null
}

async function main() {
    const apply = process.argv.includes("--apply")
  // Overpass throttles anonymous callers hard, and most of these venues are
  // demo records it has never heard of, so the lookup is opt-in rather than
  // the default. Name rules and the checked table do the work.
  const useOsm = process.argv.includes("--osm")

  const venues = await db.venues.findMany({
    where: { deleted_at: null },
    select: {
      id: true,
      name: true,
      venue_type: true,
      address: true,
      city: true,
      latitude: true,
      longitude: true,
      capacity: true,
      geofence: true,
    },
    orderBy: { name: "asc" },
  })

  console.log(`${venues.length} venue(s)\n`)
  let enriched = 0
  let skipped = 0

  for (const venue of venues) {
    const label = venue.name.slice(0, 38).padEnd(38)

    if (venue.latitude === null || venue.longitude === null) {
      console.log(`  SKIP  ${label} no coordinates`)
      skipped++
      continue
    }

    // Never overwrite something a person set. This fills blanks only.
    const needsType = venue.venue_type === null
    const needsFence = !venue.geofence
    const needsAddress = !venue.address
    if (!needsType && !needsFence && !needsAddress) {
      console.log(`  OK    ${label} already described`)
      continue
    }

    let hit: OsmHit | null = null
    if (useOsm) {
      try {
        hit = await lookup(venue.latitude, venue.longitude, venue.name)
      } catch (err) {
        console.log(`  WARN  ${label} Overpass failed (${err instanceof Error ? err.message : err})`)
      }
      await new Promise((r) => setTimeout(r, PAUSE_MS))
    }

    // Only a *named* OSM match speaks for this venue. Anything else nearby is
    // a different business that happens to share a postcode.
    const trusted = hit?.nameMatched ? hit : null
    const osmType = trusted ? venueTypeFromOsm(trusted.tags) : null
    const nameType = osmType === null ? typeFromName(venue.name) : null
    const venueType: venue_type | null = needsType ? (osmType ?? nameType) : venue.venue_type
    const typeSource = osmType ? "osm" : nameType ? "name" : "none"

    // Polygon when OSM has a real outline; otherwise a circle sized by type.
    // A guessed polygon would look authoritative and be wrong.
    let geofence: Geofence | null = null
    if (needsFence) {
      const ring = trusted?.ring
        ? trusted.ring.slice(0, -1).slice(0, GEOFENCE_LIMITS.MAX_RING)
        : null
      if (ring && ring.length >= GEOFENCE_LIMITS.MIN_RING && !ringSelfIntersects(ring)) {
        geofence = { type: "polygon", ring, buffer: 25 }
      } else {
        geofence = {
          type: "circle",
          lat: venue.latitude,
          lng: venue.longitude,
          radius: defaultExtentMetres(venueType),
          buffer: 20,
        }
      }
      // The same validator the API uses — never store something the runtime
      // would reject.
      const parsed = validateGeofence(geofence)
      if (!parsed.ok) {
        console.log(`  WARN  ${label} generated fence invalid (${parsed.error}), using circle`)
        geofence = {
          type: "circle",
          lat: venue.latitude,
          lng: venue.longitude,
          radius: defaultExtentMetres(venueType),
          buffer: 20,
        }
      }
    }

    const t = trusted?.tags ?? {}
    const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ")
    const address = needsAddress && street ? street : venue.address
    const city =
      !venue.city && (t["addr:city"] || t["addr:suburb"])
        ? (t["addr:city"] ?? t["addr:suburb"])
        : venue.city

    const shape =
      geofence?.type === "polygon"
        ? `polygon(${geofence.ring.length})`
        : geofence
          ? `circle(${geofence.radius}m)`
          : "kept"

    console.log(
      `  FILL  ${label} type=${venueTypeLabel(venueType).padEnd(20)}(${typeSource.padEnd(4)}) fence=${shape.padEnd(14)} ${
        address ? address.slice(0, 30) : "no address"
      }`
    )

    if (apply) {
      await db.venues.update({
        where: { id: venue.id },
        data: {
          ...(needsType && venueType ? { venue_type: venueType } : {}),
          ...(geofence ? { geofence: geofence as object } : {}),
          ...(address !== venue.address ? { address } : {}),
          ...(city !== venue.city ? { city } : {}),
        },
      })
    }
    enriched++
  }

  console.log(`\n${enriched} enriched, ${skipped} skipped`)
  console.log(apply ? "Applied." : "Dry run. Re-run with --apply to write.")
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
