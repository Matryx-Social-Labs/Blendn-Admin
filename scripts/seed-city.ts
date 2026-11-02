import type { PrismaClient, venue_type } from "@prisma/client"
import { buildCatalogue } from "../lib/cities"

/**
 * The scenario seed (`seed-blr-scenarios.ts`) for any catalogue city.
 *
 * The scenarios were written for Bengaluru and Bengaluru keeps them exactly:
 * the same `blr-` slugs, venues, copy and match. Another city gets the same
 * set, re-dressed by what is here: its own zone's wall clock, the venues moved
 * into its box under neutral test names, the copy's Indian places, institutions
 * and rupee amounts swapped out, and its own slug prefix — which is also how
 * `--clean` finds its rows and how the remove step knows what is not its own.
 */

export const HOME_SLUG = "bengaluru"
const HOME_PREFIX = "blr-"
/** The point the scenario venues were laid out around: Bengaluru's catalogue centre. */
const HOME_CENTRE = { lat: 12.9716, lng: 77.5946 }
/** About a kilometre in from the catalogue box's edge, so a clamped venue's fence stays inside too. */
const EDGE_MARGIN_DEG = 0.01
const MIN = 60_000

export interface SeedCity {
  slug: string
  name: string
  state: string | null
  /** The market's name, as `events.country` has always held it ("India"). */
  country: string
  timezone: string
  centre: { latitude: number; longitude: number }
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number }
  /** Every spelling that means this city (`cityKey`), from the catalogue. */
  matchKeys: string[]
  /** `cities.default_licensed_min_age`: 19 where a licensed door is 19+. */
  licensedMinAge: number | null
}

export const isHome = (city: Pick<SeedCity, "slug">) => city.slug === HOME_SLUG

/** The city as the catalogue has it (`/dashboard/markets`), or null when it has no row. */
export async function loadSeedCity(db: Pick<PrismaClient, "markets" | "cities">, slug: string): Promise<SeedCity | null> {
  const [markets, rows] = await Promise.all([db.markets.findMany(), db.cities.findMany()])
  const city = buildCatalogue(markets, rows).cities.find((c) => c.slug === slug)
  const row = rows.find((r) => r.slug === slug)
  const market = markets.find((m) => m.code === row?.market_code)
  if (!city || !row || !market) return null
  return {
    slug,
    name: city.name,
    // Bengaluru's seeded events have always said Karnataka; the catalogue's region is its code (KA).
    state: isHome(city) ? "Karnataka" : row.region,
    country: market.name,
    timezone: city.timezone,
    centre: city.centre,
    bounds: city.bounds,
    matchKeys: city.matchKeys,
    licensedMinAge: row.default_licensed_min_age,
  }
}

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/** The calendar date in `zone` at `at`, as YYYY-MM-DD. */
export const localDay = (zone: string, at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at)

/** Minutes east of UTC in `zone` at the instant `at` ("GMT+05:30", "GMT-04:00", "GMT"). */
function offsetMinutes(zone: string, at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT"
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name)
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}

/**
 * The instant a wall clock in `zone` reads `hhmm`, on the calendar day
 * `dayOffset` days after today there. The offset is read at the instant itself,
 * twice, so a day across a DST change gets that day's offset, not today's.
 */
export function wallClock(zone: string, now: Date, dayOffset: number, hhmm: string): Date {
  const [y, m, d] = localDay(zone, now).split("-").map(Number)
  const [hh, mm] = hhmm.split(":").map(Number)
  const asUtc = Date.UTC(y, m - 1, d + dayOffset, hh, mm)
  const guess = asUtc - offsetMinutes(zone, new Date(asUtc)) * MIN
  return new Date(asUtc - offsetMinutes(zone, new Date(guess)) * MIN)
}

/** A city's clock for one run: what an event's `when` is given. */
export interface Clock {
  now: Date
  wall: (dayOffset: number, hhmm: string) => Date
  day: (at: Date) => string
}

export const clockFor = (zone: string, now: Date): Clock => ({
  now,
  wall: (dayOffset, hhmm) => wallClock(zone, now, dayOffset, hhmm),
  day: (at) => localDay(zone, at),
})

/* -------------------------------------------------------------------------- */
/* Which rows are this city's                                                  */
/* -------------------------------------------------------------------------- */

export const slugPrefix = (city: Pick<SeedCity, "slug">) => (isHome(city) ? HOME_PREFIX : `${city.slug}-`)

/** A scenario's slug in `city`: `blr-evening-ragas` is `toronto-evening-ragas` in Toronto. */
export function localSlug(city: Pick<SeedCity, "slug">, homeSlug: string): string {
  if (!homeSlug.startsWith(HOME_PREFIX)) throw new Error(`scenario slug "${homeSlug}" does not start with ${HOME_PREFIX}`)
  return slugPrefix(city) + homeSlug.slice(HOME_PREFIX.length)
}

/** `--clean`: this city's seeded events and nothing else. The caller adds `realEventsWhere`, where the kind guard can see it. */
export const seededEventsWhere = (city: Pick<SeedCity, "slug">) => ({ slug: { startsWith: slugPrefix(city) }, deleted_at: null })

const insensitive = "insensitive" as const

/** What Bengaluru's remove step has always matched. */
const HOME_CITY_MATCH = {
  OR: [
    { city: { equals: "Bengaluru", mode: insensitive } },
    { city: { equals: "Bangalore", mode: insensitive } },
    { AND: [{ city: null }, { OR: [{ address: { contains: "Bengaluru", mode: insensitive } }, { address: { contains: "Bangalore", mode: insensitive } }] }] },
  ],
}

/**
 * The events the remove step may soft-delete: the city's own, by its catalogue
 * names (`events.city` is stored through the same normaliser, `clean_city_text`).
 * A row with no city counts only when its address names the city.
 */
export function cityMatchFor(city: Pick<SeedCity, "slug" | "name" | "matchKeys">) {
  if (isHome(city)) return HOME_CITY_MATCH
  return {
    OR: [
      ...city.matchKeys.map((key) => ({ city: { equals: key, mode: insensitive } })),
      { AND: [{ city: null }, { address: { contains: city.name, mode: insensitive } }] },
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* Venues                                                                      */
/* -------------------------------------------------------------------------- */

export type Fence =
  | { type: "circle"; lat: number; lng: number; radius: number; buffer: number }
  | { type: "polygon"; ring: [number, number][]; buffer: number }

export interface VenueSpec {
  name: string
  address: string
  postal: string
  lat: number
  lng: number
  type: venue_type
  capacity: number
  /** Owned by the venue test organisation, so "venue owner operates, may not edit" is testable. */
  ownedByVenueOrg?: boolean
  fence: Fence
}

/** Each scenario venue's stand-in outside Bengaluru: a name that is no real business, and a street. */
const NEUTRAL_VENUES: Record<string, readonly [name: string, street: string]> = {
  oliveBeach: ["Harbourview Terrace", "Front Street"],
  thirdWave: ["Corner Grind Coffee", "Maple Avenue"],
  bflat: ["Low Note Bar", "King Street"],
  blueTokai: ["Roastworks Coffee", "Elm Street"],
  cubbon: ["Central Park Bandstand", "Park Drive"],
  chowdiah: ["Riverside Concert Hall", "Concert Way"],
  weworkEgl: ["Commons Coworking", "Bay Street"],
  arbor: ["Oak & Barrel Brewing", "Mill Road"],
  bigPitcher: ["Tall Glass Taproom", "Station Road"],
  palaceGrounds: ["Exhibition Grounds", "Fairground Lane"],
  dialogues: ["Common Table Café", "Church Lane"],
  decathlonHebbal: ["North Trailhead (meeting point)", "Ridge Road"],
  bic: ["Civic Arts Centre", "Garden Avenue"],
  clayStation: ["Kiln & Wheel Studio", "Potter Street"],
  lupa: ["Counter Kitchen", "Market Street"],
  kittyKo: ["Afterhours Club", "Warehouse Row"],
  bygHennur: ["Big Yard Brewhouse", "Orchard Road"],
  attaGalatta: ["Paper Lantern Books", "Library Lane"],
  highUltra: ["Skyline Rooftop Lounge", "Tower Street"],
  nimhans: ["Lakeside Convention Centre", "Convention Drive"],
  jayamahal: ["Old Estate Lawns", "Estate Road"],
  toastTonic: ["Toast Room", "Queen Street"],
  churchStSocial: ["Social Hall", "High Street"],
  artRoom: ["The Easel Room", "Gallery Road"],
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6

/** Bengaluru's offset from its centre, applied to the city's, kept inside its box; the fence moves with it. */
function placeVenue(key: string, v: VenueSpec, city: SeedCity, index: number): VenueSpec {
  const neutral = NEUTRAL_VENUES[key]
  if (!neutral) throw new Error(`venue "${key}" has no neutral name for ${city.name} — add it to NEUTRAL_VENUES in scripts/seed-city.ts`)
  const { minLat, maxLat, minLon, maxLon } = city.bounds
  const inside = (x: number, lo: number, hi: number) => Math.min(hi - EDGE_MARGIN_DEG, Math.max(lo + EDGE_MARGIN_DEG, x))
  const lat = round6(inside(city.centre.latitude + v.lat - HOME_CENTRE.lat, minLat, maxLat))
  const lng = round6(inside(city.centre.longitude + v.lng - HOME_CENTRE.lng, minLon, maxLon))
  const dLat = lat - v.lat
  const dLng = lng - v.lng
  const fence: Fence =
    v.fence.type === "circle"
      ? { ...v.fence, lat: round6(v.fence.lat + dLat), lng: round6(v.fence.lng + dLng) }
      : { ...v.fence, ring: v.fence.ring.map(([a, b]) => [round6(a + dLat), round6(b + dLng)] as [number, number]) }
  return { ...v, name: `${neutral[0]} (test)`, address: `${10 + index * 7} ${neutral[1]}, ${city.name}`, postal: "", lat, lng, fence }
}

export function placeVenues<K extends string>(venues: Record<K, VenueSpec>, city: SeedCity): Record<K, VenueSpec> {
  if (isHome(city)) return venues
  const entries = (Object.entries(venues) as [K, VenueSpec][]).map(([key, v], i) => [key, placeVenue(key, v, city, i)] as const)
  return Object.fromEntries(entries) as Record<K, VenueSpec>
}

/** What a scenario link points at outside Bengaluru: nobody's real site (RFC 2606). */
export const neutralLink = (city: Pick<SeedCity, "slug">, homeSlug: string) => `https://example.com/${localSlug(city, homeSlug)}`

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The scenarios' Indian specifics, and what they read as elsewhere. In order:
 * a phrase before the words inside it, a venue's full name before its short
 * one, and the city's own name last. Rupee amounts are dropped, not converted.
 * `__tests__/seed-city.test.ts` fails on anything left over.
 */
const COPY: [RegExp, string][] = [
  // amounts
  [/Visitor parking at basement 2, ₹60\/hour/g, "Visitor parking at basement 2, paid by the hour"],
  [/parking, ₹100 per day/g, "parking, paid per day"],
  [/₹200 at the gate/g, "Paid at the gate"],
  [/₹2,800 including firing and glazing/g, "Paid, including firing and glazing"],
  [/₹6,500 per person, pairing ₹3,000/g, "Set price per person; pairing extra"],
  [/₹200 at the cloakroom/g, "Paid at the cloakroom"],
  [/₹5 lakh in prizes/g, "cash prizes"],
  [/₹5,00,000 across three tracks/g, "Cash prizes across three tracks"],
  [/₹1,800 including materials/g, "Paid, including materials"],
  // places, institutions, languages
  [/six single-origin Indian coffees/g, "six single-origin coffees"],
  [/from Chikmagalur, Coorg and the Nilgiris/g, "from three growing regions"],
  [/across India/g, "across the country"],
  [/The IMD has issued an orange alert for heavy rain/g, "The weather service has issued a heavy-rain warning"],
  [/Karnataka's harvest — Coorg pepper, Byadgi chillies, Malnad jackfruit and coastal seafood/g, "the local harvest — wild mushrooms, heirloom squash, orchard fruit and fresh seafood"],
  [/Karnataka produce/g, "local produce"],
  [/plenty of Kannada and Hindi thrown in/g, "a few other languages thrown in"],
  [/Mostly English, with Kannada and Hindi\./g, "Mostly English, with a few other languages."],
  [/Kannada with English subtitles/g, "Original language with English subtitles"],
  [/Kantara/g, "Midnight Harbour"],
  [/how the Bhoota Kola sequences were recorded/g, "how the festival sequences were recorded"],
  [/real datasets from BMTC, BBMP and/g, "real datasets from the transit agency, the city and"],
  [/BMTC bus data, Namma Metro ridership/g, "Bus data, subway ridership"],
  [/BBMP's complaint data/g, "The city's complaint data"],
  [/Do sellers take UPI\?/g, "Do sellers take cards?"],
  [/a filter coffee/g, "a coffee"],
  [/filter coffee/g, "drip coffee"],
  [/dosa at a darshini near Hebbal/g, "breakfast at a diner near the start"],
  [/walk to Airlines Hotel for dosa and coffee/g, "walk to a diner for pancakes and coffee"],
  [/Breakfast at Airlines Hotel/g, "Breakfast at a diner nearby"],
  [/bhel to bao/g, "tacos to bao"],
  [/dosa place/g, "breakfast place"],
  [/Sunday Soul Sante/g, "Sunday Soul Market"],
  [/Monsoon Landscapes/g, "Rainy-day Landscapes"],
  [/monsoon landscape/g, "rainy-day landscape"],
  [/Trek Kumara Parvatha/g, "Trek a big peak"],
  [/Grover Zampa Reserve/g, "Kestrel Hills Reserve"],
  [/Grover Zampa's winemaker/g, "the winery's winemaker"],
  [/Nandi Hills/g, "Kestrel Hills"],
  [/31 floors above Malleshwaram/g, "31 floors above downtown"],
  [/WTC (lobby|basement)/g, "tower $1"],
  [/Via the Lalit Ashok lobby/g, "Via the hotel lobby"],
  [/1 MG Road Mall/g, "Market Square Mall"],
  [/Allied Grande Plaza/g, "the plaza"],
  [/Kasturba Road gate/g, "Park Drive gate"],
  [/Domlur gate/g, "Garden Avenue gate"],
  // venues, full names first
  [/Bangalore International Centre/g, "Civic Arts Centre"],
  [/\bBIC\b/g, "the Arts Centre"],
  [/Olive Beach/g, "Harbourview Terrace"],
  [/Wood Street/g, "Front Street"],
  [/Third Wave/g, "Corner Grind"],
  [/BFlat/g, "Low Note"],
  [/Blue Tokai/g, "Roastworks"],
  [/Cubbon Park/g, "Central Park"],
  [/Chowdiah Memorial Hall/g, "Riverside Concert Hall"],
  [/Magrath Road/g, "Mill Road"],
  [/Arbor Brewing Company/g, "Oak & Barrel Brewing"],
  [/\bArbor\b/g, "Oak & Barrel"],
  [/Big Pitcher/g, "Tall Glass Taproom"],
  [/Old Airport Road/g, "Station Road"],
  [/Palace Grounds/g, "Exhibition Grounds"],
  [/Tripura Vasini hall/g, "main hall"],
  [/Dialogues/g, "Common Table"],
  [/Decathlon Hebbal/g, "North Trailhead"],
  [/Hebbal/g, "the trailhead"],
  [/Clay Station, HSR/g, "Kiln & Wheel Studio"],
  [/Lupa/g, "Counter Kitchen"],
  [/Kitty Ko/g, "Afterhours"],
  [/Byg Brewski( Hennur)?/g, "Big Yard Brewhouse"],
  [/Atta Galatta/g, "Paper Lantern Books"],
  [/High Ultra Lounge/g, "Skyline Rooftop Lounge"],
  [/High's weekly/g, "Skyline's weekly"],
  [/Jayamahal Palace/g, "Old Estate"],
  [/Toast & Tonic/g, "Toast Room"],
  [/Church Street/g, "High Street"],
  [/The Art Room, Indiranagar/g, "The Easel Room"],
  [/Koramangala/g, "Midtown"],
]

/** A scenario's copy as it reads in `city`. Bengaluru's is returned as written. */
export function localiseText(text: string, city: SeedCity): string {
  if (isHome(city)) return text
  const age = city.licensedMinAge
  const swapped = COPY.reduce((t, [from, to]) => t.replace(from, to), text).replace(/Bengaluru|Bangalore/g, city.name)
  return age ? swapped.replace(/\b21\+/g, `${age}+`).replace(/under 21\b/g, `under ${age}`) : swapped
}
