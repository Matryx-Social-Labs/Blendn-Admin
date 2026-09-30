import { PrismaClient, type connection_intent, type door_policy, type event_status, type venue_type, type visibility_type } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { syncOccurrences } from "../lib/occurrences"
import { openSession } from "../lib/presence-sessions"
import { ensureOrgBrand } from "./seed-brand"
import { describeLive, describeRefresh, holdSeedOccurrences, refreshSeededEvent } from "./seed-occurrences"
import { mirrorToTigris, SEED_BUCKET, stayedHotlinked } from "./seed-media"
import { environmentRefusal, TEST_ORG_NAMES } from "./test-accounts"
import { CROWD_CHAT, CROWD_REVIEWS, CROWD_SIZE, ensureCrowd } from "./seed-blr-crowd"
import PHOTOS from "./seed-blr-photos.json"

/**
 * Bengaluru, rebuilt so every state an event can be in is on the phone at once.
 *
 * `seed-qa.ts` builds the *world* — accounts, organisations, claims, queues —
 * and seeds events to prove particular mechanics. This script replaces the
 * city's events with a set chosen by **lifecycle**: one event per state the
 * backend and the app distinguish, each dressed as a real listing, so a tester
 * can walk every screen without editing a row or waiting for a clock.
 *
 * The states come from the code, not from intuition:
 *
 *   - `lib/event-phase.ts`      pre / live / post
 *   - `lib/occurrences.ts`      check-in opens 90 min before an occurrence
 *   - `lib/chat-window.ts`      the room is writable from start − 24h to end + 24h
 *   - `lib/chat-lifecycle.ts`   the sweeper archives a room 24h after the end
 *   - event-notifications       the reminder picks events starting in 60–75 min
 *   - `blendn/lib/scarcity.ts`  "N SPOTS LEFT" at ≤ 10 left, FULL at 0 → waitlist
 *   - `blendn/lib/pulse.ts`     Tonight / Today / Tomorrow / Happening now
 *
 * Times are offsets from the moment of the run, so the live event is live for
 * a few hours after `--apply`. Re-run `--apply` to put the clock back; it is
 * idempotent, and it resets the seeded RSVPs, check-ins and rooms on these
 * events (and only these events).
 *
 * ## What it removes
 *
 * Every other Bangalore/Bengaluru event, **soft-deleted** (`deleted_at`), which
 * is what every read path filters on and what `seed-qa.ts` already does to
 * retire rows. A hard delete would cascade through check-ins, chat and ratings
 * a tester may be looking at. Running `seed:qa --apply` afterwards puts its own
 * Bengaluru events back — run this after it, not before.
 *
 * ## Needs
 *
 * The accounts from `seed-qa.ts` (attendees, the three product owners) and
 * `test-accounts.ts` (the organiser and its organisation), and the category
 * taxonomy (`seed-categories.ts`). Missing people are skipped with a warning
 * rather than invented — an account nobody has the password for is not one a
 * tester can sign in as.
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/seed-blr-scenarios.ts            # dry run
 *   DATABASE_URL=... RAILWAY_ENVIRONMENT_NAME=staging npx tsx scripts/seed-blr-scenarios.ts --apply
 *   DATABASE_URL=... RAILWAY_ENVIRONMENT_NAME=staging npx tsx scripts/seed-blr-scenarios.ts --refresh-times
 *
 * Staging or localhost only (`environmentRefusal`).
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

const APPLY = process.argv.includes("--apply")
const REFRESH_TIMES = process.argv.includes("--refresh-times")

const CITY = "Bengaluru"
const STATE = "Karnataka"
const COUNTRY = "India"
const TZ = "Asia/Kolkata"
const SLUG_PREFIX = "blr-"

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = new Date()

/** Rounded to a clock face an organiser would pick — 19:05 reads as a bug. */
const round = (d: Date, step = 5 * MIN) => new Date(Math.round(d.getTime() / step) * step)
const fromNow = (minutes: number, step = 5 * MIN) => round(new Date(NOW.getTime() + minutes * MIN), step)

/** Today's date in Bengaluru, as YYYY-MM-DD. */
const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(NOW)

/** A wall-clock time in Bengaluru, `dayOffset` days from today. IST has no DST. */
function ist(dayOffset: number, hhmm: string): Date {
  const base = new Date(`${istToday()}T${hhmm}:00+05:30`)
  return new Date(base.getTime() + dayOffset * 24 * HOUR)
}

/**
 * "Tonight": this evening in Bengaluru if there is still one to have, so the
 * card reads "Tonight · 8:30 PM". Kept clear of the check-in window, which is
 * a different scenario. Past 22:00 there is no tonight left and it becomes
 * tomorrow night — the run says so.
 */
function tonight(): { start: Date; end: Date } {
  const preferred = ist(0, "20:30")
  if (preferred.getTime() - NOW.getTime() >= 2 * HOUR) return { start: preferred, end: new Date(preferred.getTime() + 2.5 * HOUR) }
  const soon = fromNow(150, 15 * MIN)
  const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(soon) === istToday()
  const start = sameDay ? soon : ist(1, "20:30")
  return { start, end: new Date(start.getTime() + 2.5 * HOUR) }
}

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

const PEOPLE = {
  ananya: "ananya.b@blendn.app",
  rohan: "rohan.d@blendn.app",
  kavya: "kavya.n@blendn.app",
  imran: "imran.q@blendn.app",
  sneha: "sneha.p@blendn.app",
  vikram: "vikram.s@blendn.app",
  sagar: "sagar.kishore@blendn.app",
  hemanth: "hemanth.ramesh@blendn.app",
  likhith: "likhith.gowda@blendn.app",
} as const
type Person = keyof typeof PEOPLE

const ORGANISER_EMAIL = "organizer@blendn.app"
const ADMIN_EMAIL = "admin@blendn.app"

/**
 * Room pseudonyms, stable across runs so a screenshot in a bug report still
 * matches. Unique per room (`@@unique([chat_group_id, anonymous_name])`), and
 * a busy room holds 40+, so they are generated rather than listed.
 */
const ADJECTIVES = ["Cosmic", "Quiet", "Amber", "Still", "Vivid", "Slow", "Brave", "Lunar", "Mellow", "Swift", "Gentle", "Bright"]
const ANIMALS = ["Panda", "Otter", "Fox", "Heron", "Moth", "Comet", "Kite", "Finch", "Lynx", "Koel", "Myna", "Gecko"]
const handle = (i: number) => `${ADJECTIVES[i % ADJECTIVES.length]} ${ANIMALS[(i + Math.floor(i / ADJECTIVES.length)) % ANIMALS.length]}`

const INTENTS: connection_intent[][] = [["networking", "friendship"], ["dating", "just_here"], ["friendship"], ["networking"], ["just_here"]]

/* -------------------------------------------------------------------------- */
/* Venues                                                                      */
/* -------------------------------------------------------------------------- */

type Fence =
  | { type: "circle"; lat: number; lng: number; radius: number; buffer: number }
  | { type: "polygon"; ring: [number, number][]; buffer: number }

interface VenueSpec {
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

const circle = (lat: number, lng: number, radius: number, buffer = 30): Fence => ({ type: "circle", lat, lng, radius, buffer })

const VENUES = {
  oliveBeach: { name: "Olive Beach", address: "16, Wood Street, Ashok Nagar, Bengaluru", postal: "560025", lat: 12.9719, lng: 77.611, type: "restaurant", capacity: 120, fence: circle(12.9719, 77.611, 40) },
  thirdWave: { name: "Third Wave Coffee, Koramangala", address: "80 Feet Road, 4th Block, Koramangala, Bengaluru", postal: "560034", lat: 12.9346, lng: 77.6269, type: "cafe", capacity: 45, fence: circle(12.9346, 77.6269, 25) },
  bflat: { name: "BFlat Bar", address: "776, 100 Feet Road, Indiranagar, Bengaluru", postal: "560038", lat: 12.9784, lng: 77.6408, type: "live_music_venue", capacity: 150, ownedByVenueOrg: true, fence: circle(12.9784, 77.6408, 35) },
  blueTokai: { name: "Blue Tokai Coffee Roasters, Indiranagar", address: "1st Floor, 12th Main Road, HAL 2nd Stage, Indiranagar, Bengaluru", postal: "560038", lat: 12.9707, lng: 77.64, type: "cafe", capacity: 40, fence: circle(12.9707, 77.64, 25) },
  cubbon: {
    name: "Cubbon Park Bandstand",
    address: "Kasturba Road, Ambedkar Veedhi, Sampangi Rama Nagar, Bengaluru",
    postal: "560001",
    lat: 12.9763,
    lng: 77.5929,
    type: "park_ground",
    capacity: 400,
    fence: { type: "polygon", buffer: 25, ring: [[12.9772, 77.5918], [12.9772, 77.594], [12.9754, 77.594], [12.9754, 77.5918]] },
  },
  chowdiah: { name: "Chowdiah Memorial Hall", address: "16th Cross Road, Vyalikaval, Malleshwaram, Bengaluru", postal: "560003", lat: 13.0005, lng: 77.572, type: "theatre", capacity: 1100, fence: circle(13.0005, 77.572, 60) },
  weworkEgl: { name: "WeWork Embassy Golf Links", address: "Embassy Golf Links Business Park, Off Intermediate Ring Road, Domlur, Bengaluru", postal: "560071", lat: 12.953, lng: 77.642, type: "coworking", capacity: 220, fence: circle(12.953, 77.642, 60) },
  arbor: { name: "Arbor Brewing Company", address: "8, Allied Grande Plaza, Magrath Road, Ashok Nagar, Bengaluru", postal: "560025", lat: 12.97, lng: 77.611, type: "brewery", capacity: 180, fence: circle(12.97, 77.611, 35) },
  bigPitcher: { name: "Big Pitcher", address: "4121, Old Airport Road, HAL 2nd Stage, Bengaluru", postal: "560017", lat: 12.9602, lng: 77.6484, type: "brewery", capacity: 350, fence: circle(12.9602, 77.6484, 45) },
  palaceGrounds: {
    name: "Bangalore Palace Grounds, Tripura Vasini",
    address: "Palace Grounds, Jayamahal Road, Vasanth Nagar, Bengaluru",
    postal: "560052",
    lat: 12.9987,
    lng: 77.592,
    type: "convention_centre",
    capacity: 3000,
    fence: { type: "polygon", buffer: 30, ring: [[13.0003, 77.5902], [13.0003, 77.5938], [12.9971, 77.5938], [12.9971, 77.5902]] },
  },
  dialogues: { name: "Dialogues Café", address: "18, 1st Cross Road, KHB Colony, 5th Block, Koramangala, Bengaluru", postal: "560095", lat: 12.9352, lng: 77.6147, type: "cafe", capacity: 70, fence: circle(12.9352, 77.6147, 25) },
  decathlonHebbal: { name: "Decathlon Hebbal (meeting point)", address: "Bellary Road, Kempapura, Hebbal, Bengaluru", postal: "560024", lat: 13.045, lng: 77.595, type: "retail_mall", capacity: 60, fence: circle(13.045, 77.595, 60) },
  bic: { name: "Bangalore International Centre", address: "7, 4th Main Road, Domlur II Stage, Bengaluru", postal: "560071", lat: 12.961, lng: 77.6387, type: "amphitheatre", capacity: 180, fence: circle(12.961, 77.6387, 40) },
  clayStation: { name: "Clay Station", address: "1219, 24th Main Road, Sector 2, HSR Layout, Bengaluru", postal: "560102", lat: 12.9121, lng: 77.6446, type: "studio", capacity: 16, fence: circle(12.9121, 77.6446, 25) },
  lupa: { name: "Lupa", address: "Level 1, 1 MG Road Mall, MG Road, Bengaluru", postal: "560001", lat: 12.9755, lng: 77.608, type: "restaurant", capacity: 90, fence: circle(12.9755, 77.608, 30) },
  kittyKo: { name: "Kitty Ko, The Lalit Ashok", address: "Kumara Krupa High Grounds, Seshadripuram, Bengaluru", postal: "560001", lat: 12.9906, lng: 77.5873, type: "nightclub", capacity: 500, fence: circle(12.9906, 77.5873, 50) },
  bygHennur: { name: "Byg Brewski Brewing Company, Hennur", address: "Behind MK Retail, Hennur Main Road, Byrathi, Bengaluru", postal: "560077", lat: 13.0358, lng: 77.6425, type: "brewery", capacity: 1200, fence: circle(13.0358, 77.6425, 80) },
  attaGalatta: { name: "Atta Galatta", address: "134, KHB Colony, 5th Block, Koramangala, Bengaluru", postal: "560095", lat: 12.9326, lng: 77.628, type: "library", capacity: 60, fence: circle(12.9326, 77.628, 20) },
  highUltra: { name: "High Ultra Lounge", address: "31st Floor, World Trade Center, Brigade Gateway, Malleshwaram West, Bengaluru", postal: "560055", lat: 13.012, lng: 77.555, type: "lounge_rooftop", capacity: 300, fence: circle(13.012, 77.555, 40) },
  nimhans: { name: "NIMHANS Convention Centre", address: "Hosur Road, Lakkasandra, Wilson Garden, Bengaluru", postal: "560029", lat: 12.9422, lng: 77.596, type: "convention_centre", capacity: 900, fence: circle(12.9422, 77.596, 80) },
  jayamahal: { name: "Jayamahal Palace Hotel Lawns", address: "1, Jayamahal Road, Jayamahal, Bengaluru", postal: "560046", lat: 13.001, lng: 77.598, type: "park_ground", capacity: 2000, fence: circle(13.001, 77.598, 120) },
  toastTonic: { name: "Toast & Tonic", address: "14/1, Wood Street, Ashok Nagar, Bengaluru", postal: "560025", lat: 12.9728, lng: 77.6071, type: "restaurant", capacity: 110, ownedByVenueOrg: true, fence: circle(12.9728, 77.6071, 30) },
  churchStSocial: { name: "Church Street Social", address: "46/1, Church Street, Bengaluru", postal: "560001", lat: 12.975, lng: 77.6058, type: "pub_bar", capacity: 160, fence: circle(12.975, 77.6058, 30) },
  artRoom: { name: "The Art Room", address: "3rd Floor, 2985, 12th Main Road, HAL 2nd Stage, Indiranagar, Bengaluru", postal: "560008", lat: 12.9716, lng: 77.6412, type: "studio", capacity: 24, fence: circle(12.9716, 77.6412, 25) },
} satisfies Record<string, VenueSpec>
type VenueKey = keyof typeof VENUES

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

type PhotoKey = Exclude<keyof typeof PHOTOS, "_clip">

interface Social {
  going?: Person[]
  maybe?: Person[]
  waitlisted?: Person[]
  /** "Interested" — `event_favorites`. */
  favorites?: Person[]
  /** Inside right now, with an open presence session. */
  checkedIn?: Person[]
  /** Came and left. */
  checkedOut?: Person[]
  ratings?: [Person, number, string][]
  room?: "active" | "locked" | "archived"
  chat?: [Person, string][]
  /** Posted by the organiser, into `event_announcements` and the room. */
  announcement?: string
  /** Attendee messages the sentiment pass would have classified. Index into `chat`. */
  feedback?: { line: number; sentiment: "positive" | "neutral" | "negative"; category: "entry_queue" | "crowding" | "facilities" | "sound_av" | "staff_service" | "food_drink" | "wayfinding" | "other" }[]
  sponsor?: "approved" | "proposed"
  /**
   * How many of the crowd (`seed-blr-crowd.ts`) join the named people. Going
   * people are the ones who check in and review, so `inside`/`attended` are
   * taken from the front of the crowd's going list; `rated` from the front of
   * `attended`. Keep totals within `capacity`.
   */
  crowd?: { going?: number; interested?: number; waitlisted?: number; inside?: number; attended?: number; rated?: number; chat?: number }
}

interface EventSpec {
  slug: string
  /** What this row exists to make testable. Printed on a dry run. */
  scenario: string
  title: string
  short: string
  description: string
  full: string
  photos: PhotoKey
  venue: VenueKey
  /** How the venue got attached, when it did. Free text only when absent. */
  venueLink?: "confirmed" | "auto_linked" | null
  when: () => { start: Date; end: Date }
  status?: event_status
  visibility?: visibility_type
  capacity: number | null
  minAge?: number | null
  door?: door_policy
  featured?: boolean
  recurring?: boolean
  link?: string | null
  curated?: { source: string; claimed: boolean }
  deleted?: boolean
  /** Cancel the last day of a multi-day event. */
  cancelLastDay?: boolean
  /** Leave `reminded_at` null even though the reminder window has passed. */
  reminderPending?: boolean
  video?: boolean
  categories: [string, ...string[]]
  amenities: string[]
  details: {
    houseRules: string
    cancellation: string
    health?: string
    faq: { question: string; answer: string }[]
    access: Record<string, string>
    extra: Record<string, string>
  }
  social?: Social
}

const EVENTS: EventSpec[] = [
  /* ── before it starts ──────────────────────────────────────────────────── */
  {
    slug: "blr-sunday-jazz-brunch",
    scenario: "UPCOMING, next week. The everything-filled card: RSVPs, interested, full details.",
    title: "Sunday Jazz Brunch at Olive Beach",
    short: "A long, slow Sunday brunch on the terrace with a live jazz trio.",
    description:
      "The Ashwin Rao Trio plays two sets of standards and Bossa Nova on the Olive Beach terrace while the kitchen sends out a Mediterranean brunch spread.\n\nCome alone or bring friends — tables are shared, and the Blendn room opens a day before so you can find people to sit with.",
    full:
      "Olive Beach has been doing Sunday brunch on Wood Street for nearly two decades, and this is the version with a band.\n\nThe Ashwin Rao Trio (piano, upright bass, drums) plays two 45-minute sets — the first leans on Bill Evans and Ahmad Jamal, the second is Bossa Nova and whatever the room asks for.\n\nThe brunch is the house spread: mezze, wood-fired flatbreads, shakshuka, a grill station and the dessert table people come back for. Brunch cocktails and fresh juices are on the bar.\n\nSeating is at long shared tables on purpose. If you're coming solo, check in when you arrive and say hello in the room — the organiser keeps a table for people who came to meet people.",
    photos: "jazz-brunch",
    venue: "oliveBeach",
    venueLink: "confirmed",
    when: () => ({ start: ist(6, "12:00"), end: ist(6, "16:00") }),
    capacity: 90,
    featured: true,
    link: "https://www.olivebeach.in",
    categories: ["food-drink-brunch", "music-live-gigs"],
    amenities: ["live-music", "food-included", "welcome-drink", "outdoor-space", "step-free-access", "parking"],
    details: {
      houseRules: "Smart casual. Kids welcome until 3 PM. Please keep the terrace aisles clear for the band's gear.",
      cancellation: "Free cancellation up to 24 hours before. After that, your RSVP is released to the waitlist.",
      faq: [
        { question: "Is the brunch included?", answer: "Yes — the buffet and one welcome drink are included. The bar is pay-as-you-go." },
        { question: "Are there vegetarian and vegan options?", answer: "Most of the spread is vegetarian and every station has a labelled vegan option." },
        { question: "Can I come for just one set?", answer: "Of course. The first set starts at 12:30 and the second at 2:15." },
      ],
      access: { Entrance: "Step-free from Wood Street", Toilets: "Accessible toilet on the ground floor", Seating: "Chairs with backs at every table" },
      extra: { "Dress code": "Smart casual", Parking: "Valet on Wood Street", Age: "All ages" },
    },
    social: { going: ["rohan", "kavya", "ananya", "sneha"], maybe: ["imran"], favorites: ["ananya", "vikram", "hemanth", "sagar"] },
  },
  {
    slug: "blr-founders-breakfast",
    scenario: "TOMORROW, morning. 'Tomorrow · 8:30 AM', small capped room.",
    title: "Founders' Breakfast Club — Koramangala",
    short: "Twenty founders, one long table, filter coffee and no pitch decks.",
    description:
      "An early, informal breakfast for people building companies in Bengaluru. No talks, no pitching — just a good breakfast and a table of people who get it.\n\nWe mix the seating every 30 minutes so you meet at least six new people before your first call.",
    full:
      "Founders' Breakfast Club started as six people who kept running into each other at Third Wave at 8 AM. It now runs every other Tuesday.\n\nThe format is simple: breakfast is on the table at 8:30, and every 30 minutes the host rotates half the table. By 10 you'll have had a real conversation with six or seven people at a similar stage.\n\nWho comes: pre-seed to Series A founders, a few operators thinking about starting something, and the occasional angel who promises not to talk about their portfolio.\n\nThe only rule: no pitching. If someone wants to hear more, they'll ask.",
    photos: "founders-breakfast",
    venue: "thirdWave",
    venueLink: "auto_linked",
    when: () => ({ start: ist(1, "08:30"), end: ist(1, "10:30") }),
    capacity: 24,
    recurring: true,
    categories: ["networking-founders", "food-drink-coffee"],
    amenities: ["food-included", "wifi", "quiet-area"],
    details: {
      houseRules: "No pitching. Laptops stay closed at the table. Arrive by 8:45 so the first rotation works.",
      cancellation: "Please release your seat by 8 PM the night before — there's always a waitlist.",
      faq: [
        { question: "Do I need to be a founder?", answer: "Mostly founders, with a few operators and angels. If you're building something, you're welcome." },
        { question: "What does it cost?", answer: "Nothing. Breakfast is covered by the host this season." },
      ],
      access: { Entrance: "Two steps at the front door; staff can help", Toilets: "Standard" },
      extra: { Format: "Seats rotate every 30 minutes", Frequency: "Every other Tuesday" },
    },
    social: { going: ["sagar", "likhith", "imran"], favorites: ["hemanth", "ananya"] },
  },
  {
    slug: "blr-standup-tonight",
    scenario: "TONIGHT. 'Tonight · 8:30 PM' label; age 18+ with an open door.",
    title: "Tuesday Stand-up at BFlat",
    short: "Five of the city's sharpest comics trying new material on a full room.",
    description:
      "BFlat's weekly stand-up night: a host, five comics and a 90-minute set list that changes every week. Expect new material, some of it great, all of it honest.\n\nThe bar stays open through the show. Seats are first come, first served.",
    full:
      "BFlat turns into a comedy room every Tuesday. The line-up rotates between the regulars from the Bengaluru circuit and comics passing through on tour.\n\nThe format: a host warms up the room, then five comics do 12–15 minutes each. It's a work-in-progress night, so the material is new — that's the fun of it.\n\nSeating is cabaret-style around small tables. Arrive by 8:15 if you want to sit together; the front row is, as always, at your own risk.\n\nThe show is in English with plenty of Kannada and Hindi thrown in.",
    photos: "comedy",
    venue: "bflat",
    venueLink: "confirmed",
    when: tonight,
    capacity: 120,
    minAge: 18,
    categories: ["nightlife-comedy"],
    amenities: ["cloakroom", "accessible-toilets"],
    details: {
      houseRules: "Phones on silent. No recording the sets — the comics are testing material. Heckling is between you and the host.",
      cancellation: "Free RSVP; if you can't make it, cancel so someone on the waitlist gets your seat.",
      faq: [
        { question: "Is there a cover charge?", answer: "No cover. There is a one-drink minimum at the bar." },
        { question: "What language is the show in?", answer: "Mostly English, with Kannada and Hindi." },
      ],
      access: { Entrance: "Ground floor, step-free", Toilets: "Accessible toilet available", Sound: "Loud — ear plugs at the bar" },
      extra: { Age: "18+", "Show length": "About 90 minutes" },
    },
    social: { going: ["kavya", "vikram", "rohan"], favorites: ["ananya", "sneha"] },
  },
  {
    slug: "blr-coffee-cupping",
    scenario: "CHECK-IN OPEN, not started (starts in ~45 min). Room open early; sponsor placed; reminder already sent.",
    title: "Specialty Coffee Cupping with Blue Tokai",
    short: "Taste six single-origin Indian coffees side by side with the roasting team.",
    description:
      "Blue Tokai's roasters walk you through a professional cupping of six single-estate coffees from Chikmagalur, Coorg and the Nilgiris.\n\nYou'll learn to break the crust, slurp like a Q-grader and tell a washed coffee from a natural. Small group, lots of questions welcome.",
    full:
      "Cupping is how roasters and buyers taste coffee — every cup brewed the same way, so the only difference is the bean. It's also the fastest way to understand why coffee tastes the way it does.\n\nThe Blue Tokai roasting team sets out six coffees: two washed, two natural, one honey-processed and one experimental lot from this season. You'll smell the dry grounds, break the crust at four minutes and taste each cup as it cools.\n\nAt the end we compare notes, reveal the estates and talk about how processing and roast change what's in the cup.\n\nEveryone leaves with a 250 g bag of their favourite from the table.",
    photos: "coffee-cupping",
    venue: "blueTokai",
    venueLink: "confirmed",
    when: () => {
      const start = fromNow(45)
      return { start, end: new Date(start.getTime() + 2 * HOUR) }
    },
    capacity: 16,
    categories: ["food-drink-coffee", "food-drink-tastings"],
    amenities: ["food-included", "wifi", "quiet-area"],
    details: {
      houseRules: "Please skip perfume or cologne — cupping is all about smell. Arrive five minutes early so we can start on time.",
      cancellation: "Free cancellation up to 2 hours before.",
      faq: [
        { question: "Do I need to know anything about coffee?", answer: "Not at all. The session starts from the basics." },
        { question: "Is there decaf?", answer: "One of the six is a Swiss Water decaf, so there's always a cup for you." },
        { question: "Do I take coffee home?", answer: "Yes — a 250 g bag of your pick." },
      ],
      access: { Entrance: "First floor, stairs only", Seating: "Standing at the cupping table; stools on request" },
      extra: { "What to bring": "Nothing — spoons and notebooks provided", Group: "Maximum 16" },
    },
    social: {
      going: ["sneha", "imran", "rohan", "kavya", "ananya"],
      favorites: ["hemanth"],
      room: "active",
      chat: [
        ["sneha", "first time at a cupping, any tips?"],
        ["imran", "don't wear perfume and slurp loudly, it's allowed 😄"],
      ],
      sponsor: "approved",
    },
  },
  {
    slug: "blr-community-yoga",
    scenario: "REMINDER DUE (starts in ~65 min, reminded_at null). The 'starting soon' push picks this up.",
    title: "Community Yoga & Breathwork",
    short: "An hour of slow flow and pranayama, open to every level.",
    description:
      "A gentle, all-levels class led by Meera Iyer: 45 minutes of slow vinyasa followed by 15 minutes of pranayama and rest.\n\nMats are provided, but bring your own if you have one. Wear something you can move in.",
    full:
      "Meera has been teaching in Bengaluru for ten years and started this class to make yoga feel less like a gym membership and more like a neighbourhood thing.\n\nThe class: a short check-in, 45 minutes of slow flow with plenty of options for every body, then 15 minutes of breathwork — nadi shodhana and a long, supported savasana.\n\nNo experience needed. If you have an injury, tell Meera before class and she'll give you alternatives.\n\nStay after for a tea and to meet the people on the mats next to you.",
    photos: "sunset-yoga",
    venue: "cubbon",
    venueLink: "confirmed",
    when: () => {
      const start = fromNow(65)
      return { start, end: new Date(start.getTime() + 75 * MIN) }
    },
    reminderPending: true,
    recurring: true,
    capacity: 40,
    categories: ["wellness-yoga", "wellness-meditation"],
    amenities: ["outdoor-space", "step-free-access", "quiet-area"],
    details: {
      houseRules: "Arrive ten minutes early. Phones on silent. Please take your litter with you — it's a public park.",
      cancellation: "Free class. In heavy rain it moves to the covered bandstand; if it's cancelled you'll get a notification.",
      health: "Drink water before class. Tell the teacher about any injuries or if you're pregnant.",
      faq: [
        { question: "Do I need a mat?", answer: "We have 25 mats to lend. Bring your own if you can." },
        { question: "Is it suitable for beginners?", answer: "Yes — every pose has an easier option." },
      ],
      access: { Entrance: "Step-free from Kasturba Road gate", Surface: "Grass and paved bandstand" },
      extra: { Level: "All levels", "What to wear": "Comfortable clothes" },
    },
    social: { going: ["kavya", "sneha", "ananya"], favorites: ["rohan", "likhith", "ananya", "vikram"] },
  },

  /* ── happening now ─────────────────────────────────────────────────────── */
  {
    slug: "blr-evening-ragas",
    scenario: "JUST STARTED (10 min ago). Live, first arrivals, 'Happening now'.",
    title: "Evening Ragas: Sitar & Tabla Recital",
    short: "A two-hour recital of sitar and tabla, with a vocal opening.",
    description:
      "Sitarist Nikhil Kulkarni and tabla player Aniruddh Bhat in a two-hour recital, opened by a short vocal alaap with tanpura.\n\nThe programme moves from an evening raga to a fast drut gat, and closes with a tabla solo and requests.",
    full:
      "Chowdiah Memorial Hall — the auditorium shaped like a violin — is one of the best rooms in the city for acoustic music.\n\nThe programme:\n• Vocal alaap in Yaman with tanpura\n• Main piece: Raga Yaman — alaap, jor, jhala\n• Vilambit and drut gat in teentaal\n• Tabla solo\n• A light piece and audience requests\n\nNew to Indian classical music? There's a short introduction before the main piece explaining what to listen for. Seating is unreserved — the centre of the balcony has the best sound.",
    photos: "carnatic",
    venue: "chowdiah",
    venueLink: "confirmed",
    when: () => {
      const start = fromNow(-10)
      return { start, end: new Date(start.getTime() + 2.5 * HOUR) }
    },
    capacity: 800,
    categories: ["music-classical-and-carnatic"],
    amenities: ["step-free-access", "accessible-toilets", "parking", "quiet-area"],
    details: {
      houseRules: "Entry between pieces only. No photography during the performance. Phones off, please.",
      cancellation: "Free entry; no booking needed beyond the RSVP.",
      faq: [
        { question: "Can I enter late?", answer: "Yes, between pieces — ushers will seat you." },
        { question: "Is it suitable for children?", answer: "Children over 8 who can sit through a long concert are welcome." },
      ],
      access: { Entrance: "Ramp at the main entrance", Seating: "Wheelchair spaces in row K", Toilets: "Accessible toilets on the ground floor" },
      extra: { Duration: "About 2.5 hours with no interval", Parking: "Free parking in the hall compound" },
    },
    social: {
      going: ["sneha", "likhith", "kavya"],
      checkedIn: ["sneha", "likhith"],
      favorites: ["hemanth"],
      room: "active",
      chat: [
        ["sneha", "the balcony really does sound better"],
        ["likhith", "saving two seats in row C if anyone's still outside"],
      ],
    },
  },
  {
    slug: "blr-ai-in-production-meetup",
    scenario: "LIVE, busy (halfway through). Six inside, active room with announcement, sponsor, match preferences.",
    title: "AI in Production — Bangalore Tech Meetup #42",
    short: "Three talks on shipping LLM features that survive real users.",
    description:
      "Three practitioner talks on what actually happens when you put language models in front of millions of users — evals, latency budgets and the bills nobody warned you about.\n\nPizza and drinks after the talks. Hosted by Nightshift Collective, coffee by Blue Tokai.",
    full:
      "Bangalore Tech Meetup has run monthly since 2019. This edition is about the unglamorous half of AI: running it.\n\nTalks:\n1. \"Evals are your test suite now\" — Priya Menon, Staff Engineer. How her team gates every prompt change on an evaluation set, and what they got wrong the first time.\n2. \"The 800 ms budget\" — Arjun Shetty, Principal Engineer. Streaming, caching and choosing where the model runs so a feature feels instant.\n3. \"Your AI bill is a product decision\" — Farah Khan, Head of Platform. Token budgets, routing to smaller models, and the dashboard finance actually reads.\n\nEach talk is 20 minutes with 10 minutes of questions. Networking runs until 10 PM.",
    photos: "tech-meetup",
    venue: "weworkEgl",
    venueLink: "confirmed",
    when: () => {
      const start = fromNow(-120)
      return { start, end: new Date(start.getTime() + 4 * HOUR) }
    },
    capacity: 150,
    featured: true,
    link: "https://www.meetup.com/bangalore-tech-meetup/",
    categories: ["tech-meetups", "tech-talks"],
    amenities: ["wifi", "food-included", "welcome-drink", "step-free-access", "accessible-toilets", "cloakroom"],
    details: {
      houseRules: "Be kind in Q&A. Recruiters: talk to people, don't hand out forms. Badges are required past reception.",
      cancellation: "Free event. If you can't come, cancel your RSVP so the waitlist moves.",
      faq: [
        { question: "Will the talks be recorded?", answer: "Yes, they go up on the meetup's YouTube channel within a week." },
        { question: "Can I bring a laptop?", answer: "Yes, and there's Wi-Fi — the password is at reception." },
        { question: "How do I get in?", answer: "Show your RSVP at reception in Tower B, 3rd floor, and they'll print a badge." },
      ],
      access: { Entrance: "Lift to the 3rd floor, Tower B", Toilets: "Accessible toilets on every floor", Captions: "Live captions on the side screen" },
      extra: { Parking: "Visitor parking at basement 2, ₹60/hour", Food: "Pizza after the talks (veg and non-veg)" },
    },
    social: {
      going: ["rohan", "kavya", "imran", "sneha", "vikram", "sagar", "hemanth"],
      checkedIn: ["rohan", "kavya", "imran", "sneha", "vikram", "sagar"],
      favorites: ["ananya", "likhith"],
      room: "active",
      announcement: "Talk 3 is starting in 5 minutes in the main hall. Pizza is out in the pantry right after!",
      chat: [
        ["rohan", "anyone else here for the evals talk?"],
        ["kavya", "yes! been fighting flaky prompts all week"],
        ["imran", "the 800 ms budget talk was 🔥"],
        ["sneha", "is there a slide link anywhere?"],
        ["vikram", "they said the deck goes up on the meetup page tonight"],
        ["sagar", "grabbing coffee at the back, come say hi"],
        ["kavya", "the wifi password is on the pillar near reception btw"],
        ["rohan", "saving seats in row 3 for talk 3"],
      ],
      sponsor: "approved",
    },
  },
  {
    slug: "blr-craft-beer-flight",
    scenario: "ENDING SOON (ends in ~15 min). Still live, check-in still allowed.",
    title: "Craft Beer Flight Night at Arbor",
    short: "Five seasonal brews, a brewer's walkthrough and bar snacks.",
    description:
      "Arbor's head brewer pours a flight of five seasonal beers — a Belgian wit, a hazy IPA, a mango sour, a smoked porter and one experimental keg — and talks through how each is made.\n\nBar snacks included. Stay on for happy hour afterwards.",
    full:
      "Arbor Brewing Company has been brewing on Magrath Road since 2012. Flight Night is their monthly tasting with the brewing team.\n\nThe flight (150 ml each):\n• Belgian Wit — orange peel and coriander\n• Hazy IPA — Citra and Mosaic, soft and juicy\n• Mango Sour — kettle-soured with Alphonso pulp\n• Smoked Porter — beechwood-smoked malt\n• Brewer's Choice — whatever's in the experimental tank this month\n\nBetween pours the brewer explains malt, hops, yeast and what goes wrong. Questions are very much encouraged.",
    photos: "craft-beer",
    venue: "arbor",
    venueLink: "confirmed",
    when: () => {
      const end = fromNow(15)
      return { start: new Date(end.getTime() - 3 * HOUR), end }
    },
    capacity: 60,
    minAge: 21,
    categories: ["food-drink-tastings", "nightlife-parties"],
    amenities: ["food-included", "open-bar", "cloakroom"],
    details: {
      houseRules: "21+ with ID. Drink responsibly — we'll call you a cab. Water is free and plentiful.",
      cancellation: "Cancel up to 12 hours before for a full refund.",
      faq: [
        { question: "Can I swap a beer in the flight?", answer: "Tell the bartender — non-alcoholic kombucha is available as a swap." },
        { question: "Is food included?", answer: "A bar-snack platter per two people is included." },
      ],
      access: { Entrance: "Ground floor, step-free", Toilets: "Standard" },
      extra: { Age: "21+ (ID checked)", "Getting home": "Cab stand outside Allied Grande Plaza" },
    },
    social: {
      going: ["vikram", "imran", "rohan"],
      checkedIn: ["vikram", "imran"],
      room: "active",
      chat: [
        ["vikram", "the mango sour is unreal"],
        ["imran", "porter > everything else, fight me"],
      ],
    },
  },
  {
    slug: "blr-premier-league-screening",
    scenario: "LIVE, room LOCKED by the organiser — read-only.",
    title: "Premier League Screening: Arsenal vs Liverpool",
    short: "The big match on a 20-foot screen, with commentary turned up.",
    description:
      "Big Pitcher's rooftop becomes a stand for the evening's Premier League clash. Twenty-foot screen, full commentary and the whole bar on its feet.\n\nArrive early — the good tables go by kick-off.",
    full:
      "The Bengaluru Gooners and the Kop Bangalore supporters' clubs are sharing the rooftop for this one, so expect noise.\n\nThe screen goes up an hour before kick-off with the pre-match show. Commentary is on the main speakers; the side bar shows the stats feed.\n\nThe kitchen runs a match-day menu — wings, sliders, loaded fries — and there are buckets and pitchers at the bar.\n\nPlease keep it friendly. Both clubs' admins are around if anything gets out of hand.",
    photos: "football-screening",
    venue: "bigPitcher",
    venueLink: "confirmed",
    when: () => {
      const start = fromNow(-60)
      return { start, end: new Date(start.getTime() + 3 * HOUR) }
    },
    capacity: 250,
    categories: ["sports-football-screening"],
    amenities: ["rooftop", "open-bar", "food-included", "parking"],
    details: {
      houseRules: "No flares, no pyro, no abuse — the bar will ask you to leave. Club colours welcome.",
      cancellation: "Free entry with RSVP. Table reservations are separate through the bar.",
      faq: [
        { question: "Is there an entry charge?", answer: "No, it's free with RSVP. Food and drinks are on your tab." },
        { question: "Which screen has the best view?", answer: "The main screen on the rooftop; the indoor bar also shows the match." },
      ],
      access: { Entrance: "Lift to the rooftop", Toilets: "Accessible toilet on level 2" },
      extra: { "Kick-off": "One hour after doors", Parking: "Paid parking on Old Airport Road" },
    },
    social: {
      going: ["rohan", "vikram", "hemanth"],
      checkedIn: ["rohan", "vikram"],
      room: "locked",
      announcement: "The room is read-only for the second half — see you at the next screening!",
      chat: [
        ["rohan", "what a goal!!!"],
        ["vikram", "VAR is going to ruin this, I can feel it"],
      ],
    },
  },
  {
    slug: "blr-design-festival",
    scenario: "MULTI-DAY, on day 2 of 3, last day CANCELLED. Occurrences per day; polygon venue; check-in resolves today.",
    title: "Bengaluru Design Festival 2026",
    short: "Three days of installations, studio talks and a makers' market.",
    description:
      "The city's design festival returns to Palace Grounds with 40 installations, studio talks from Bengaluru's best practices and a makers' market of independent brands.\n\nDay 3 has been cancelled because of the forecast — days 1 and 2 go ahead as planned.",
    full:
      "Bengaluru Design Festival brings architecture, product, graphic and textile design together under one roof — well, several tents — at Palace Grounds.\n\nWhat's on:\n• 40 installations from studios and students across India\n• Studio talks every afternoon at 3 PM in the Tripura Vasini hall\n• A makers' market with 80 independent brands\n• Portfolio reviews for students (sign up at the info desk)\n\nUpdate: the final day has been called off because of the heavy-rain warning. Days 1 and 2 run as planned; entry passes for day 3 are valid on day 2.\n\nYour check-in is per day, so check in again each day you come.",
    photos: "design-festival",
    venue: "palaceGrounds",
    venueLink: "confirmed",
    when: () => ({ start: fromNow(-(24 * 60 + 120), 15 * MIN), end: fromNow(24 * 60 + 360, 15 * MIN) }),
    cancelLastDay: true,
    capacity: 2500,
    featured: true,
    link: "https://www.bengalurudesignfestival.in",
    categories: ["arts-culture-exhibitions", "markets-fairs-craft-markets"],
    amenities: ["step-free-access", "accessible-toilets", "food-included", "outdoor-space", "parking", "wifi"],
    details: {
      houseRules: "Please don't touch the installations unless they say so. Photography is welcome; tripods need a pass.",
      cancellation: "Day 3 is cancelled; day-3 passes are valid on day 2. No other changes.",
      faq: [
        { question: "Do I need a separate check-in each day?", answer: "Yes — check in at the gate each day you come." },
        { question: "Is there food?", answer: "A food court with 12 stalls near Gate 2." },
        { question: "Why is day 3 cancelled?", answer: "The IMD has issued an orange alert for heavy rain; the tents aren't rated for it." },
      ],
      access: { Entrance: "Gate 2 is step-free", Toilets: "Accessible toilets near the food court", Buggies: "Free buggy between halls" },
      extra: { Parking: "Palace Grounds parking, ₹100 per day", Kids: "Kids' workshop tent near Gate 1" },
    },
    social: {
      going: ["ananya", "kavya", "sneha", "likhith"],
      checkedIn: ["kavya", "likhith"],
      favorites: ["rohan", "hemanth"],
      room: "active",
      chat: [
        ["kavya", "the bamboo pavilion near gate 2 is stunning"],
        ["likhith", "anyone going to the 3 PM studio talk?"],
        ["kavya", "yes, meet at the info desk at 2:50"],
      ],
    },
  },

  /* ── after it ends ─────────────────────────────────────────────────────── */
  {
    slug: "blr-board-game-night",
    scenario: "ENDED 2h ago. Room still open (< 24h), attendees see RATE, feedback in chat.",
    title: "Board Game Night at Dialogues",
    short: "Strategy, party and co-op games with a host to teach you the rules.",
    description:
      "Dialogues' library of 200+ board games comes off the shelf for an evening of Catan, Codenames, Azul and whatever you want to learn.\n\nOur game hosts teach every game, so no experience needed. Come alone — we'll put you at a table.",
    full:
      "Board Game Night is the easiest way to meet people without having to make small talk: the game does the talking.\n\nHow it works: you check in, tell a host what you're in the mood for (quick party game, big strategy game, co-op) and they seat you at a table with people who want the same thing.\n\nPopular picks: Catan, Codenames, Azul, Ticket to Ride, Wingspan, Dixit and The Crew. The hosts teach every game in under ten minutes.\n\nThe café kitchen is open all evening — the nachos and cold coffees are the classics.",
    photos: "board-games",
    venue: "dialogues",
    venueLink: "confirmed",
    when: () => {
      const end = fromNow(-120)
      return { start: new Date(end.getTime() - 3.5 * HOUR), end }
    },
    capacity: 50,
    categories: ["social-board-games", "social-meet-new-people"],
    amenities: ["food-included", "wifi", "quiet-area"],
    details: {
      houseRules: "Please return games to the shelf with all their pieces. Be patient with first-timers.",
      cancellation: "Free event — just cancel your RSVP if you can't come.",
      faq: [
        { question: "Do I need to know the games?", answer: "No, the hosts teach everything." },
        { question: "Can I bring my own game?", answer: "Yes, as long as you're happy to teach it." },
      ],
      access: { Entrance: "Ground floor, step-free", Toilets: "Standard" },
      extra: { Food: "Café menu, pay as you go", Group: "Tables of 4–6" },
    },
    social: {
      going: ["ananya", "rohan", "kavya", "imran", "vikram"],
      checkedOut: ["ananya", "rohan", "kavya", "imran"],
      ratings: [
        ["rohan", 5, "Best way to meet people — Codenames with strangers was hilarious."],
        ["kavya", 4, "Great hosts, a bit crowded near the counter."],
        ["imran", 5, "Learned Wingspan in 10 minutes. Coming back next week."],
      ],
      room: "active",
      chat: [
        ["rohan", "who wants to play catan at table 4?"],
        ["kavya", "the queue at the counter was so long tonight"],
        ["imran", "thanks for the wingspan lesson everyone!"],
        ["ananya", "that was so much fun, same time next week?"],
      ],
      feedback: [
        { line: 1, sentiment: "negative", category: "entry_queue" },
        { line: 2, sentiment: "positive", category: "staff_service" },
        { line: 3, sentiment: "positive", category: "other" },
      ],
    },
  },
  {
    slug: "blr-nandi-sunrise-ride",
    scenario: "ENDED 3 days ago. Room ARCHIVED (read-only history), ratings in.",
    title: "Nandi Hills Sunrise Ride",
    short: "A 70 km group ride to catch sunrise at the top of Nandi Hills.",
    description:
      "A no-drop group ride from Hebbal to the top of Nandi Hills for sunrise, and back in time for breakfast.\n\nPace is moderate (22–25 km/h on the flat). The climb is 8 km — go at your own pace, we regroup at the top.",
    full:
      "The ride: we roll out from Decathlon Hebbal at 4:30 AM, ride 35 km up the airport road to the base of Nandi Hills, then climb the 36 hairpins to the top for sunrise.\n\nIt's a no-drop ride — a sweep rider stays at the back and nobody gets left behind. We regroup at the base and at the top.\n\nAfter sunrise and a filter coffee at the top, we descend together and ride back for dosa at a darshini near Hebbal.\n\nYou'll need a road or hybrid bike in good condition, a helmet (mandatory), front and rear lights, and two bottles of water.",
    photos: "cycling-sunrise",
    venue: "decathlonHebbal",
    venueLink: null,
    when: () => ({ start: ist(-3, "04:30"), end: ist(-3, "10:00") }),
    capacity: 40,
    recurring: true,
    categories: ["outdoor-cycling", "sports-running"],
    amenities: ["outdoor-space", "parking"],
    details: {
      houseRules: "Helmets are mandatory. Lights on until sunrise. Ride single file on the highway.",
      cancellation: "Rides are cancelled for rain; you'll get a notification by 9 PM the night before.",
      health: "Eat something before you leave and carry electrolytes. Tell the ride lead about any medical conditions.",
      faq: [
        { question: "Can I rent a bike?", answer: "Decathlon Hebbal rents hybrids — book a day ahead." },
        { question: "What if I can't finish the climb?", answer: "The sweep rider stays with you; walking is fine." },
      ],
      access: { Terrain: "Highway and an 8 km climb with 36 hairpins" },
      extra: { Distance: "70 km round trip", Pace: "22–25 km/h on the flat" },
    },
    social: {
      going: ["vikram", "rohan", "sagar", "ananya"],
      checkedOut: ["vikram", "rohan", "sagar", "ananya"],
      ratings: [
        ["vikram", 5, "That sunrise above the clouds was worth the 4 AM alarm."],
        ["sagar", 4, "Great group. The descent was cold — bring a jacket."],
      ],
      room: "archived",
      chat: [
        ["vikram", "made it to the top 🙌"],
        ["sagar", "clouds below us, unreal"],
        ["rohan", "dosa place was perfect, thanks for organising"],
      ],
    },
  },
  {
    slug: "blr-sunday-soul-sante",
    scenario: "ENDED a week ago. History for 'Attended' on Going; out of discovery.",
    title: "Sunday Soul Sante — Flea Market",
    short: "Two hundred stalls of vintage, handmade and street food on the palace lawns.",
    description:
      "Bengaluru's biggest flea market takes over the Jayamahal Palace lawns for a day: vintage clothes, handmade jewellery, plants, records, art and a very long food row.\n\nLive music on the main stage from noon.",
    full:
      "Sunday Soul Sante has been running since 2015 and brings together over 200 independent sellers.\n\nWhat you'll find: vintage and thrift, handloom and handmade clothing, jewellery, ceramics, plants, books and records, plus a food row with everything from bhel to bao.\n\nThe main stage has live bands from noon until close, and there's a kids' zone with face painting and games.\n\nBring a tote bag — most sellers are plastic-free.",
    photos: "flea-market",
    venue: "jayamahal",
    venueLink: "auto_linked",
    when: () => ({ start: ist(-7, "11:00"), end: ist(-7, "21:00") }),
    capacity: 5000,
    categories: ["markets-fairs-flea-markets", "food-drink-food-festivals"],
    amenities: ["live-music", "outdoor-space", "parking", "accessible-toilets"],
    details: {
      houseRules: "No pets on the lawns. Please use the recycling points.",
      cancellation: "Tickets are non-refundable but transferable.",
      faq: [{ question: "Do sellers take UPI?", answer: "Almost all of them do." }],
      access: { Entrance: "Step-free from the main gate", Surface: "Lawn — can be uneven" },
      extra: { Entry: "₹200 at the gate", Pets: "Not allowed" },
    },
    social: {
      going: ["ananya", "sneha", "kavya"],
      checkedOut: ["ananya", "sneha", "kavya"],
      ratings: [["sneha", 4, "Loved it, but the food row was packed by 2 PM."]],
    },
  },

  /* ── status and capacity ───────────────────────────────────────────────── */
  {
    slug: "blr-open-air-cinema",
    scenario: "CANCELLED, with RSVPs — shows as 'Cancelled by the organiser' on Going; gone from the Pulse.",
    title: "Open-air Cinema: Kantara under the Stars",
    short: "A screening on the BIC lawn with blankets, beanbags and popcorn.",
    description:
      "An open-air screening on the Bangalore International Centre lawn, with blankets, beanbags and a short conversation with the film's sound designer before the show.\n\nThis screening has been cancelled because of the rain forecast. We'll announce a new date soon.",
    full:
      "Update: this screening is cancelled. The forecast shows heavy rain all evening and the lawn has no cover. Everyone who RSVP'd will hear first about the new date.\n\nOriginally planned: a screening of Kantara on BIC's lawn, preceded by a 20-minute conversation with the film's sound designer on how the Bhoota Kola sequences were recorded.\n\nSeating was going to be on beanbags and blankets, with popcorn and filter coffee from the BIC café.",
    photos: "open-air-film",
    venue: "bic",
    venueLink: "confirmed",
    when: () => ({ start: ist(2, "19:00"), end: ist(2, "22:00") }),
    status: "cancelled",
    capacity: 150,
    categories: ["arts-culture-film-screenings"],
    amenities: ["outdoor-space", "food-included", "step-free-access"],
    details: {
      houseRules: "Please bring a light jacket. Outside food is not allowed on the lawn.",
      cancellation: "This screening is cancelled. RSVPs roll over to the new date automatically.",
      faq: [{ question: "Will there be a new date?", answer: "Yes — you'll be notified as soon as it's set." }],
      access: { Entrance: "Step-free via the Domlur gate" },
      extra: { Language: "Kannada with English subtitles", Runtime: "2 hours 30 minutes" },
    },
    social: { going: ["ananya", "rohan", "kavya", "hemanth"], favorites: ["sneha"] },
  },
  {
    slug: "blr-pottery-workshop",
    scenario: "ALMOST FULL: capacity 12, 7 going → '5 SPOTS LEFT' pill.",
    title: "Wheel-throwing Pottery Workshop",
    short: "Three hours at the wheel — you'll leave with two pieces to glaze.",
    description:
      "A beginners' wheel-throwing class at Clay Station, HSR. You'll learn to centre, open and pull up a pot, and throw two pieces of your own.\n\nThe studio glazes and fires them, and they're ready to collect in three weeks.",
    full:
      "Pottery is harder than it looks and more fun than you'd think. This workshop is designed for complete beginners.\n\nWhat you'll do:\n• A demo of centring, opening and pulling walls\n• Two hours at your own wheel with the instructor coming round\n• Trim and sign your two best pieces\n\nThe studio glazes and fires your work (choose from six glazes) and it's ready to collect in about three weeks.\n\nWear clothes you don't mind getting muddy; aprons are provided. Keep your nails short if you can.",
    photos: "pottery",
    venue: "clayStation",
    venueLink: "confirmed",
    when: () => ({ start: ist(3, "11:00"), end: ist(3, "14:00") }),
    capacity: 12,
    categories: ["arts-culture-workshops", "learning-classes-and-courses"],
    amenities: ["food-included", "quiet-area"],
    details: {
      houseRules: "Clothes that can get muddy. Short nails help. No outside food near the wheels.",
      cancellation: "Full refund up to 48 hours before; after that, you can send a friend in your place.",
      faq: [
        { question: "Do I need experience?", answer: "None at all — this is a beginners' class." },
        { question: "When can I collect my pieces?", answer: "About three weeks later; we'll message you." },
      ],
      access: { Entrance: "Ground-floor studio, one small step", Seating: "Wheel stools; standing option available" },
      extra: { Price: "₹2,800 including firing and glazing", Group: "Maximum 12" },
    },
    social: { going: ["ananya", "kavya", "sneha", "imran", "rohan", "vikram", "likhith"], favorites: ["sagar"] },
  },
  {
    slug: "blr-chefs-table-lupa",
    scenario: "FULL → WAITLIST: capacity 6, 6 going, Ananya waitlisted. RSVP from anyone else joins the waitlist.",
    title: "Chef's Table at Lupa",
    short: "A seven-course tasting menu for six guests at the kitchen counter.",
    description:
      "Six seats at the kitchen counter for a seven-course tasting menu cooked in front of you by Lupa's chef de cuisine, with optional wine pairing.\n\nThe menu follows the season — this month it's built around Karnataka produce.",
    full:
      "Chef's Table is Lupa's most intimate dinner: six guests sit at the pass and eat what the kitchen is excited about that week.\n\nThis month's menu is built around Karnataka's harvest — Coorg pepper, Byadgi chillies, Malnad jackfruit and coastal seafood — cooked with Lupa's European technique.\n\nSeven courses over about two and a half hours, with the chef explaining each dish. Wine pairing is optional and chosen by the sommelier.\n\nIt's a communal counter, so you'll be dining with the other five guests — part of the fun.",
    photos: "supper-club",
    venue: "lupa",
    venueLink: "confirmed",
    when: () => ({ start: ist(4, "20:00"), end: ist(4, "22:30") }),
    capacity: 6,
    categories: ["food-drink-supper-clubs"],
    amenities: ["food-included", "welcome-drink", "step-free-access", "accessible-toilets"],
    details: {
      houseRules: "Please tell us about allergies when you RSVP. Smart casual. We start on time — the first course is served at 8:15.",
      cancellation: "Cancel at least 72 hours before; after that, the seat is charged unless someone from the waitlist takes it.",
      faq: [
        { question: "Can the menu be vegetarian?", answer: "Yes — tell us when you RSVP and the kitchen will adapt every course." },
        { question: "How does the waitlist work?", answer: "If someone cancels, the first person on the waitlist gets the seat and a notification." },
      ],
      access: { Entrance: "Lift to Level 1 of 1 MG Road Mall", Seating: "Counter stools; a lower table is available on request" },
      extra: { Price: "₹6,500 per person, pairing ₹3,000", "Dress code": "Smart casual" },
    },
    social: { going: ["rohan", "kavya", "imran", "sneha", "sagar", "likhith"], waitlisted: ["ananya"], favorites: ["vikram"] },
  },
  {
    slug: "blr-techno-warehouse",
    scenario: "21+ AGE GATE and GUEST-LIST door. Hidden from viewers whose age is under 21.",
    title: "Warehouse Techno: Kitty Ko After Dark",
    short: "Four hours of techno from two international headliners and local openers.",
    description:
      "Kitty Ko goes dark for a night of warehouse techno: two international headliners, two Bengaluru openers and a new d&b sound system.\n\nGuest list only — RSVP here and your name goes on the door. 21+ with ID.",
    full:
      "After Dark is Kitty Ko's monthly techno night, and this edition brings in two headliners from Berlin's Tresor roster alongside local openers from the Bengaluru underground.\n\nSet times:\n• 10:00 PM — Opening set (local)\n• 11:30 PM — Second opener (local)\n• 12:45 AM — Headliner 1\n• 2:15 AM — Headliner 2 until close\n\nThe room is lit only by the rig — no phones on the dance floor, please. There's a quiet lounge with water and seating upstairs.\n\nGuest list only: your RSVP puts your name on the door. Bring a government ID; 21+ is strictly enforced.",
    photos: "techno-party",
    venue: "kittyKo",
    venueLink: "confirmed",
    when: () => ({ start: ist(4, "22:00"), end: ist(5, "03:00") }),
    capacity: 400,
    minAge: 21,
    door: "guest_list",
    categories: ["nightlife-dj-sets", "music-electronic"],
    amenities: ["dj-set", "open-bar", "cloakroom", "quiet-area"],
    details: {
      houseRules: "21+ with government ID. No phones on the dance floor. Zero tolerance for harassment — tell any staff member in a black T-shirt.",
      cancellation: "Guest list is free; if you can't come, cancel so someone else gets on.",
      faq: [
        { question: "What does guest list mean?", answer: "Your RSVP puts your name on the door list. Bring ID matching your name." },
        { question: "Is there a dress code?", answer: "Dark and comfortable. No sports jerseys." },
      ],
      access: { Entrance: "Via the Lalit Ashok lobby, lift to the club", Toilets: "Accessible toilet in the lobby" },
      extra: { Age: "21+ strictly", Door: "Guest list only", Lockers: "₹200 at the cloakroom" },
    },
    social: { going: ["vikram", "rohan", "imran"], favorites: ["kavya", "hemanth"] },
  },
  {
    slug: "blr-singles-mixer",
    scenario: "SOCIAL category, 18+, members-only door. The case Blendn exists for.",
    title: "Singles Mixer at Byg Brewski",
    short: "Icebreaker games, a cocktail and a room full of people also here to meet someone.",
    description:
      "A relaxed singles evening at Byg Brewski Hennur: an icebreaker game to start, a welcome cocktail, and then an evening of conversation on the garden deck.\n\nNo speed-dating bell, no pressure. Blendn's room tells you who's here and open to saying hello.",
    full:
      "Meeting someone new is easier when everyone in the room is there for the same reason.\n\nThe evening:\n• 7:30 PM — Arrive, check in and grab your welcome cocktail\n• 8:00 PM — A short icebreaker game run by the host (optional, but fun)\n• 8:30 PM onwards — Open mixer on the garden deck\n\nThe Blendn room is where it gets useful: check in, set your intent, and you'll see who else is here and open to meeting. Nobody sees you unless you choose to be seen.\n\nMembers-only means Blendn members — you just need to be signed in and checked in.",
    photos: "speed-dating",
    venue: "bygHennur",
    venueLink: "confirmed",
    when: () => ({ start: ist(5, "19:30"), end: ist(5, "23:00") }),
    capacity: 120,
    minAge: 18,
    door: "members_only",
    categories: ["social-singles-nights", "social-meet-new-people"],
    amenities: ["welcome-drink", "outdoor-space", "dj-set", "parking"],
    details: {
      houseRules: "Be respectful — no means no. The host and venue staff will remove anyone making others uncomfortable.",
      cancellation: "Free RSVP; please cancel if you can't come so the balance of the room stays right.",
      faq: [
        { question: "Do I have to play the icebreaker?", answer: "No, it's completely optional." },
        { question: "Who will see my profile?", answer: "Only people checked in at the event, and only what you choose to reveal." },
      ],
      access: { Entrance: "Step-free from the parking lot", Toilets: "Accessible toilets near the main bar" },
      extra: { Age: "18+", Door: "Blendn members", "Welcome drink": "One cocktail or mocktail" },
    },
    social: { going: ["kavya", "imran", "vikram", "sneha"], favorites: ["rohan", "ananya"] },
  },

  /* ── provenance ────────────────────────────────────────────────────────── */
  {
    slug: "blr-author-evening-atta-galatta",
    scenario: "CURATED, UNCLAIMED — listed by Blendn from a public listing; claim link in the payload.",
    title: "Author Evening: Writing Bengaluru",
    short: "Three authors on writing the city, followed by a signing.",
    description:
      "Three writers who've set their books in Bengaluru talk about the city as a character — its lakes, its traffic, its old bungalows and new towers — with a reading from each.\n\nBook signing and chai after the conversation.",
    full:
      "Listed by Blendn from Atta Galatta's public events page. If you run this event, you can claim it to manage it here.\n\nThe conversation brings together a novelist, a poet and a non-fiction writer whose work is rooted in Bengaluru, moderated by a journalist from the city's literary scene.\n\nEach author reads for ten minutes, followed by a 40-minute conversation and audience questions. Books are available at the bookshop counter and the authors will sign after.\n\nSeating is limited in the reading room — arrive early.",
    photos: "literature-talk",
    venue: "attaGalatta",
    venueLink: "auto_linked",
    when: () => ({ start: ist(6, "17:00"), end: ist(6, "19:00") }),
    capacity: 60,
    curated: { source: "https://attagalatta.com/events/writing-bengaluru", claimed: false },
    categories: ["arts-culture-literature"],
    amenities: ["quiet-area", "wifi"],
    details: {
      houseRules: "Phones on silent during readings.",
      cancellation: "Free event.",
      faq: [{ question: "Is this event run by Blendn?", answer: "No — it's listed from Atta Galatta's public page. Check their page for any changes." }],
      access: { Entrance: "Ground floor, one step" },
      extra: { Source: "Atta Galatta events page" },
    },
    social: { favorites: ["ananya", "sneha"] },
  },
  {
    slug: "blr-build-bengaluru-hackathon",
    scenario: "CURATED then CLAIMED by the organiser; multi-day (36h) upcoming; sponsor proposed.",
    title: "Build Bengaluru: 36-hour Civic Tech Hackathon",
    short: "Build tools for the city's lakes, roads and public transport — in 36 hours.",
    description:
      "Teams of up to four spend 36 hours building civic tech for Bengaluru, with real datasets from BMTC, BBMP and the lake conservation trusts.\n\nMentors on site, food all weekend, and ₹5 lakh in prizes.",
    full:
      "Build Bengaluru is a 36-hour hackathon for people who want to fix something about the city.\n\nTracks:\n• Mobility — BMTC bus data, Namma Metro ridership, last-mile gaps\n• Lakes & water — sensor data from the lake conservation trusts\n• Roads & civic complaints — BBMP's complaint data and ward budgets\n\nSchedule: kick-off at 9 AM on day 1, hacking through the night, demos at 5 PM on day 2 and prizes at 8 PM.\n\nTeams of 1–4. Solo? We run team-forming at 9:30 AM. Mentors from civic organisations and engineering teams will be on the floor throughout.\n\nOriginally listed from the organisers' public page; the organisers have since claimed it on Blendn.",
    photos: "hackathon",
    venue: "nimhans",
    venueLink: "confirmed",
    when: () => ({ start: ist(12, "09:00"), end: ist(13, "21:00") }),
    capacity: 300,
    link: "https://buildbengaluru.devfolio.co",
    curated: { source: "https://buildbengaluru.devfolio.co", claimed: true },
    categories: ["tech-hackathons", "business-professional-conferences"],
    amenities: ["wifi", "food-included", "quiet-area", "accessible-toilets", "parking", "cloakroom"],
    details: {
      houseRules: "Code of conduct applies at all times. No alcohol on the hacking floor. Sleeping rooms are on level 2.",
      cancellation: "Free. If your team drops out, tell us by the Wednesday before so we can admit the waitlist.",
      faq: [
        { question: "Do I need a team?", answer: "No — team-forming starts at 9:30 AM on day 1." },
        { question: "Who owns what we build?", answer: "You do. Winning teams are asked to open-source their work." },
        { question: "Is food provided?", answer: "Breakfast, lunch, dinner and midnight snacks on both days." },
      ],
      access: { Entrance: "Step-free, lift to all floors", Toilets: "Accessible toilets on each floor", "Quiet room": "Level 2" },
      extra: { Prizes: "₹5,00,000 across three tracks", "Team size": "1–4" },
    },
    social: { going: ["imran", "vikram", "likhith", "hemanth"], favorites: ["rohan", "ananya", "sagar"], sponsor: "proposed" },
  },
  {
    slug: "blr-rooftop-sundowner",
    scenario: "VIDEO in the media (plays on the Featured card); featured; tomorrow evening.",
    title: "Rooftop Sundowner: House & Disco",
    short: "Sunset over the city from the 31st floor, with house and disco till late.",
    description:
      "High Ultra Lounge's open-air rooftop, 31 floors above Malleshwaram, with a house-and-disco set from sunset until midnight.\n\nArrive for golden hour — the view west over the city is the best in Bengaluru.",
    full:
      "The Sundowner is High's weekly sunset session. The DJ starts with slow disco and nu-house as the sun goes down and builds through the evening.\n\nThe bar runs a sundowner menu of spritzes and gin-and-tonics until 8 PM; the kitchen does small plates all night.\n\nThe terrace is open-air — on a clear evening you can see all the way to Nandi Hills. If it rains, the party moves to the covered lounge.\n\nSmart casual; no shorts or flip-flops after 8 PM.",
    photos: "rooftop-dj",
    video: true,
    venue: "highUltra",
    venueLink: "confirmed",
    when: () => ({ start: ist(1, "18:00"), end: ist(2, "00:00") }),
    capacity: 250,
    featured: true,
    minAge: 21,
    link: "https://www.highultralounge.com",
    categories: ["nightlife-dj-sets", "food-drink-cocktails-and-mixology"],
    amenities: ["rooftop", "dj-set", "open-bar", "cloakroom", "step-free-access"],
    details: {
      houseRules: "21+. Smart casual — no shorts or flip-flops after 8 PM. The terrace edge is off-limits.",
      cancellation: "Free RSVP; table bookings are through the venue.",
      faq: [
        { question: "What time is sunset?", answer: "Around 6:15 PM — come by 5:45 for golden hour." },
        { question: "What if it rains?", answer: "The party moves into the covered lounge." },
      ],
      access: { Entrance: "Express lift from the WTC lobby", Toilets: "Accessible toilet on the 31st floor" },
      extra: { Age: "21+", Parking: "WTC basement parking" },
    },
    social: { going: ["sneha", "kavya", "rohan"], favorites: ["ananya", "vikram", "imran", "hemanth", "likhith"] },
  },
  {
    slug: "blr-cubbon-10k-run-club",
    scenario: "RECURRING weekly; free, uncapped (no capacity pill); early morning.",
    title: "Cubbon Park 10K Run Club",
    short: "A social 5K or 10K loop of Cubbon Park, then coffee.",
    description:
      "Every Saturday morning we run one or two loops of Cubbon Park at conversational pace — 5K or 10K, your choice — and then get coffee together.\n\nAll paces welcome; there's a pacer for every group.",
    full:
      "Cubbon Park 10K Run Club has run every Saturday since 2021, rain or shine (well, mostly).\n\nThe route is a 5 km loop through the park's shaded inner roads, which are closed to traffic early morning. Do one loop or two.\n\nPace groups: 5:30/km, 6:30/km and 7:30/km, each with a pacer. Nobody runs alone.\n\nAfterwards we walk to Airlines Hotel for dosa and coffee — the best part, some would say.",
    photos: "run-club",
    venue: "cubbon",
    venueLink: "confirmed",
    when: () => ({ start: ist(2, "06:00"), end: ist(2, "07:30") }),
    capacity: null,
    recurring: true,
    categories: ["sports-running", "wellness-fitness"],
    amenities: ["outdoor-space", "step-free-access"],
    details: {
      houseRules: "Stay on the left, keep headphones low enough to hear your pacer, and look out for walkers.",
      cancellation: "Free and uncapped — just show up.",
      health: "Hydrate beforehand and run at a pace you can talk at.",
      faq: [
        { question: "Do I need to be fast?", answer: "No — the slowest group is 7:30/km, and walking breaks are fine." },
        { question: "Where do we meet?", answer: "At the bandstand, by the statue of Queen Victoria." },
      ],
      access: { Surface: "Paved inner roads, gentle slopes" },
      extra: { Distance: "5K or 10K", "After-run": "Breakfast at Airlines Hotel" },
    },
    social: { going: ["sagar", "vikram"], favorites: ["kavya", "sneha", "rohan"] },
  },

  /* ── must NOT reach an attendee ────────────────────────────────────────── */
  {
    slug: "blr-paint-and-sip-draft",
    scenario: "NEGATIVE — DRAFT. Must never appear in the feed, search, or by id (404).",
    title: "Paint & Sip: Monsoon Landscapes",
    short: "A guided acrylic painting class with a glass of wine.",
    description:
      "A relaxed two-hour painting class where an artist walks you step by step through a monsoon landscape in acrylics.\n\nAll materials and one glass of wine included.",
    full:
      "Draft — not yet published.\n\nAn evening painting class at The Art Room, Indiranagar. The artist demonstrates each stage and you paint along; by the end everyone takes home a finished canvas.\n\nAll materials are provided, along with a glass of wine or a mocktail.",
    photos: "art-workshop",
    venue: "artRoom",
    venueLink: "confirmed",
    when: () => ({ start: ist(8, "18:30"), end: ist(8, "20:30") }),
    status: "draft",
    capacity: 20,
    categories: ["arts-culture-workshops"],
    amenities: ["welcome-drink", "quiet-area"],
    details: {
      houseRules: "Wear something you don't mind getting paint on.",
      cancellation: "Full refund up to 48 hours before.",
      faq: [{ question: "Do I need to be able to paint?", answer: "Not at all." }],
      access: { Entrance: "Third floor, lift available" },
      extra: { Price: "₹1,800 including materials" },
    },
  },
  {
    slug: "blr-private-wine-tasting",
    scenario: "NEGATIVE — PRIVATE. Hidden from feed and search; 404 on detail without access.",
    title: "Private Wine Tasting: Grover Zampa Reserve",
    short: "An invite-only tasting of six Nandi Hills reserve wines.",
    description:
      "An invite-only evening with Grover Zampa's winemaker, tasting six reserve wines from their Nandi Hills vineyards paired with small plates.\n\nBy invitation only.",
    full:
      "A private tasting for the winery's club members and invited guests.\n\nThe winemaker walks through six reserve wines — two whites, a rosé and three reds — grown on the slopes of Nandi Hills, paired with small plates from Toast & Tonic's kitchen.",
    photos: "wine-tasting",
    venue: "toastTonic",
    venueLink: "confirmed",
    when: () => ({ start: ist(3, "19:30"), end: ist(3, "22:00") }),
    visibility: "private",
    capacity: 30,
    minAge: 21,
    door: "invite_only",
    categories: ["food-drink-tastings"],
    amenities: ["open-bar", "food-included"],
    details: {
      houseRules: "21+. Invitation required at the door.",
      cancellation: "Please let the host know if you can't attend.",
      faq: [{ question: "Can I bring a guest?", answer: "Only if your invitation says so." }],
      access: { Entrance: "Private dining room, ground floor" },
      extra: { Door: "Invite only" },
    },
  },
  {
    slug: "blr-beta-testers-mixer",
    scenario: "NEGATIVE for discovery — UNLISTED. Not in feed or search, but opens from a direct link.",
    title: "Blendn Beta Testers' Mixer",
    short: "Drinks with the team for everyone who's been testing the app.",
    description:
      "A thank-you evening for Blendn's beta testers: drinks on us, a sneak peek at what's next and a chance to tell the team what to fix.\n\nUnlisted — shared by link only.",
    full:
      "If you've been filing bugs, sending screenshots or just using the app every week — this one's for you.\n\nThe team will demo what's coming next, and there's a feedback wall where you can tell us exactly what annoys you. Drinks and bar food are on us.",
    photos: "tech-meetup",
    venue: "churchStSocial",
    venueLink: "auto_linked",
    when: () => ({ start: ist(7, "19:00"), end: ist(7, "22:00") }),
    visibility: "unlisted",
    capacity: 60,
    categories: ["tech-meetups", "networking-industry-mixers"],
    amenities: ["open-bar", "food-included"],
    details: {
      houseRules: "Be honest with your feedback — that's the point.",
      cancellation: "Free.",
      faq: [{ question: "Can I bring a friend?", answer: "Yes, one guest each." }],
      access: { Entrance: "Ground floor" },
      extra: { Visibility: "Link only" },
    },
    social: { going: ["hemanth", "sagar", "likhith"] },
  },
  {
    slug: "blr-deleted-listing",
    scenario: "NEGATIVE — SOFT-DELETED. Must not exist to any reader.",
    title: "Church Street Record Fair",
    short: "Vinyl dealers from across India on one street.",
    description: "A one-day record fair on Church Street. This listing was removed by the organiser.",
    full: "Removed by the organiser.",
    photos: "flea-market",
    venue: "churchStSocial",
    venueLink: null,
    when: () => ({ start: ist(9, "11:00"), end: ist(9, "19:00") }),
    deleted: true,
    capacity: 500,
    categories: ["markets-fairs-flea-markets"],
    amenities: ["outdoor-space"],
    details: {
      houseRules: "—",
      cancellation: "Removed.",
      faq: [],
      access: {},
      extra: {},
    },
  },
]

/** The crowd on each event — sized to the scenario and within capacity. */
const CROWD: Record<string, NonNullable<Social["crowd"]>> = {
  "blr-sunday-jazz-brunch": { going: 34, interested: 12 },
  "blr-founders-breakfast": { going: 14, interested: 8 },
  "blr-standup-tonight": { going: 28, interested: 12 },
  "blr-coffee-cupping": { going: 8, interested: 5, chat: 2 },
  "blr-community-yoga": { going: 18, interested: 10 },
  "blr-evening-ragas": { going: 20, interested: 6, inside: 9, chat: 2 },
  "blr-ai-in-production-meetup": { going: 40, interested: 8, inside: 30, chat: 6 },
  "blr-craft-beer-flight": { going: 22, inside: 18, chat: 3 },
  "blr-premier-league-screening": { going: 30, inside: 25, chat: 4 },
  "blr-design-festival": { going: 30, interested: 10, inside: 20, chat: 3 },
  "blr-board-game-night": { going: 30, attended: 24, rated: 12, chat: 4 },
  "blr-nandi-sunrise-ride": { going: 16, attended: 14, rated: 8, chat: 2 },
  "blr-sunday-soul-sante": { going: 30, attended: 28, rated: 10 },
  "blr-open-air-cinema": { going: 25, interested: 10 },
  "blr-chefs-table-lupa": { waitlisted: 2, interested: 6 },
  "blr-techno-warehouse": { going: 35, interested: 12 },
  "blr-singles-mixer": { going: 30, interested: 15 },
  "blr-author-evening-atta-galatta": { going: 10, interested: 12 },
  "blr-build-bengaluru-hackathon": { going: 26, interested: 12 },
  "blr-rooftop-sundowner": { going: 20, interested: 18 },
  "blr-cubbon-10k-run-club": { going: 15, interested: 6 },
  "blr-beta-testers-mixer": { going: 10 },
}
for (const e of EVENTS) {
  const c = CROWD[e.slug]
  if (c) e.social = { ...(e.social ?? {}), crowd: c }
}

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

interface Photo {
  id: string
  alt: string
}

/** Square master, per docs/MEDIA.md: organisers upload one square and the app crops per slot. */
const photoUrl = (id: string) => `https://images.unsplash.com/${id}?w=1600&h=1600&fit=crop&q=80&fm=jpg`

/**
 * Cover and gallery for an event, mirrored into our bucket when Tigris is
 * configured (the same `mirrorToTigris` seed-qa uses — an object already there
 * is used as is). Without credentials they stay on Unsplash's CDN, which
 * serves the phone's image loader; the run names what stayed hotlinked.
 *
 * The negatives reuse another event's photographs, reversed, since nobody is
 * meant to see them.
 */
async function mediaFor(spec: EventSpec) {
  const all = (PHOTOS as unknown as Record<string, Photo[]>)[spec.photos]
  if (!all || all.length === 0) throw new Error(`no photos for "${spec.photos}" in seed-blr-photos.json`)
  const reuse = EVENTS.some((e) => e !== spec && e.photos === spec.photos && EVENTS.indexOf(e) < EVENTS.indexOf(spec))
  const photos = reuse ? [...all].reverse() : all
  const objects: { key: string; url: string }[] = []
  const hosted = async (source: string, key: string, type: string) => {
    const url = await mirrorToTigris(source, key, type)
    objects.push({ key, url })
    return url
  }
  const [first, ...rest] = photos
  const cover = { url: await hosted(photoUrl(first.id), `seed/${spec.slug}/cover.jpg`, "image/jpeg"), alt: first.alt }
  const gallery = []
  for (const [i, p] of rest.entries()) {
    gallery.push({ url: await hosted(photoUrl(p.id), `seed/${spec.slug}/gallery-${i + 1}.jpg`, "image/jpeg"), alt: p.alt })
  }
  const clipSource = (PHOTOS as unknown as { _clip?: { url: string; alt: string } })._clip
  const clip = spec.video && clipSource
    ? { url: await hosted(clipSource.url, `seed/${spec.slug}/clip.mp4`, "video/mp4"), alt: clipSource.alt }
    : null
  return { cover, gallery, clip, hotlinked: stayedHotlinked(objects) }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

const cityMatch = {
  OR: [
    { city: { equals: "Bengaluru", mode: "insensitive" as const } },
    { city: { equals: "Bangalore", mode: "insensitive" as const } },
    { AND: [{ city: null }, { OR: [{ address: { contains: "Bengaluru", mode: "insensitive" as const } }, { address: { contains: "Bangalore", mode: "insensitive" as const } }] }] },
  ],
}

/**
 * Rows other seed scripts own and that are not Bengaluru *listings*:
 * `seed-me-demo.ts` gives one account an unlisted, already-ended history for
 * the Me tab. Hiding those empties somebody's profile, not the city's feed.
 */
const KEEP_SLUG_PREFIXES = ["me-demo-"]
const notOurs = { AND: [{ slug: { not: { startsWith: SLUG_PREFIX } } }, ...KEEP_SLUG_PREFIXES.map((p) => ({ NOT: { slug: { startsWith: p } } }))] }

/** As if the reminder sweep already ran, except on the event that is waiting for it. */
const remindedAt = (spec: EventSpec, start: Date): Date | null =>
  !spec.reminderPending && start.getTime() - NOW.getTime() < 60 * MIN ? new Date(start.getTime() - 60 * MIN) : null

/** Every day of the span at the spec's capacity, and the last one cancelled when the spec says so. */
async function placeDays(spec: EventSpec, eventId: string, start: Date, end: Date) {
  await holdSeedOccurrences(db, eventId, spec.capacity, () => syncOccurrences(eventId, start, end, TZ))
  if (!spec.cancelLastDay) return
  const last = await db.event_occurrences.findFirst({ where: { event_id: eventId, cancelled_at: null }, orderBy: { start_time: "desc" } })
  if (last) await db.event_occurrences.update({ where: { id: last.id }, data: { cancelled_at: new Date(NOW.getTime() - 6 * HOUR) } })
}

/**
 * `--refresh-times`: every scenario event back at its offset from now, its days
 * re-synced, and a room the archive sweep closed reopened — nothing else
 * (SCRUM-482). `--apply` resets these events' RSVPs, check-ins and rooms under
 * whoever is testing, and soft-deletes every other Bengaluru event, seed-qa's
 * live one included; this is the only way back to a live event that does
 * neither. The seeded check-ins and RSVPs stay where they were, as with
 * `seed-qa.ts --refresh-times`.
 */
async function refreshTimes() {
  const live: string[] = []
  for (const spec of EVENTS) {
    if (spec.deleted) continue
    const { start, end } = spec.when()
    const result = await refreshSeededEvent(
      db,
      spec.slug,
      { start, end, data: { reminded_at: remindedAt(spec, start) } },
      (event) => placeDays(spec, event.id, start, end)
    )
    console.log(describeRefresh(spec.slug, result, start))
    if (result.status === "moved" && start <= NOW && end > NOW) live.push(spec.slug)
  }
  console.log(describeLive(live))
}

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host
    } catch {
      return "(unparseable DATABASE_URL)"
    }
  })()
  console.log(`\ndatabase: ${host}`)
  console.log(
    REFRESH_TIMES
      ? "mode:     REFRESH TIMES — event times, days and closed rooms only\n"
      : APPLY
        ? "mode:     APPLY — this will write\n"
        : "mode:     dry run\n"
  )

  const refusal = environmentRefusal(process.env)
  if (refusal) {
    console.error(`REFUSING: ${refusal}`)
    process.exitCode = 1
    return
  }
  if (REFRESH_TIMES) {
    await refreshTimes()
    return
  }

  const doomed = await db.events.findMany({
    where: { ...cityMatch, deleted_at: null, ...notOurs },
    select: { slug: true, title: true, status: true },
    orderBy: { start_time: "asc" },
  })
  console.log(`Soft-delete ${doomed.length} existing Bengaluru event(s):`)
  for (const e of doomed) console.log(`    - ${e.slug.padEnd(40)} ${e.status.padEnd(10)} ${e.title}`)

  console.log(`\nSeed ${EVENTS.length} scenario events:`)
  for (const e of EVENTS) {
    const { start, end } = e.when()
    console.log(`    ${e.slug.padEnd(38)} ${fmt(start)} → ${fmt(end)}\n      ${e.scenario}`)
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.\n")
    return
  }

  /* ── who ──────────────────────────────────────────────────────────────── */
  const organiser = await db.user.findUnique({ where: { email: ORGANISER_EMAIL }, select: { id: true } })
  const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true } })
  if (!organiser || !admin) {
    console.error(`REFUSING: ${ORGANISER_EMAIL} / ${ADMIN_EMAIL} missing — run scripts/test-accounts.ts (or seed:qa) first.`)
    process.exitCode = 1
    return
  }
  const eventsOrg = await db.organisations.findFirst({ where: { display_name: TEST_ORG_NAMES.events }, select: { id: true, display_name: true } })
  const venuesOrg = await db.organisations.findFirst({ where: { display_name: TEST_ORG_NAMES.venues }, select: { id: true } })
  const venueOwner = await db.user.findUnique({ where: { email: "venue.owner@blendn.app" }, select: { id: true } })
  const brandsOrg = await db.organisations.findFirst({ where: { display_name: TEST_ORG_NAMES.brands }, select: { id: true } })
  const people: Partial<Record<Person, string>> = {}
  for (const [key, email] of Object.entries(PEOPLE) as [Person, string][]) {
    const u = await db.user.findUnique({ where: { email }, select: { id: true } })
    if (u) people[key] = u.id
    else console.log(`  !  ${email} not found — run seed:qa --apply to create the attendees; skipped`)
  }
  const crowdIds = await ensureCrowd(db)
  console.log(`crowd: ${crowdIds.length} profiles ready`)
  const ids = (list: Person[] | undefined) => (list ?? []).map((p) => people[p]).filter((id): id is string => !!id)

  // The brands org's one brand, however the product has since keyed it (SCRUM-456).
  const sponsor = brandsOrg
    ? await ensureOrgBrand(db, {
        name: "Blue Tokai",
        orgId: brandsOrg.id,
        createdBy: admin.id,
        claimedAt: new Date(),
        website: "https://bluetokaicoffee.com",
      })
    : null

  /* ── remove ───────────────────────────────────────────────────────────── */
  const removed = await db.events.updateMany({
    where: { ...cityMatch, deleted_at: null, ...notOurs },
    data: { deleted_at: new Date(), updated_at: new Date() },
  })
  console.log(`\nsoft-deleted ${removed.count} event(s)`)

  /* ── venues ───────────────────────────────────────────────────────────── */
  const venueIds: Partial<Record<VenueKey, string>> = {}
  for (const [key, v] of Object.entries(VENUES) as [VenueKey, VenueSpec][]) {
    const owned = v.ownedByVenueOrg && venuesOrg
    const data = {
      name: v.name,
      address: `${v.address} ${v.postal}`,
      city: CITY,
      latitude: v.lat,
      longitude: v.lng,
      capacity: v.capacity,
      venue_type: v.type,
      geofence: v.fence,
      owner_org_id: owned ? venuesOrg.id : null,
      owner_id: owned ? (venueOwner?.id ?? null) : null,
      claimed_at: owned ? new Date(NOW.getTime() - 60 * 24 * HOUR) : null,
      status: "active" as const,
      deleted_at: null,
    }
    const existing = await db.venues.findFirst({ where: { name: v.name, city: CITY }, select: { id: true } })
    const row = existing
      ? await db.venues.update({ where: { id: existing.id }, data })
      : await db.venues.create({ data: { ...data, created_by: admin.id } })
    venueIds[key] = row.id
  }

  /* ── vocabularies ─────────────────────────────────────────────────────── */
  const categoryIds = new Map(
    (await db.categories.findMany({ select: { id: true, slug: true } })).map((c) => [c.slug, c.id])
  )
  const amenityIds = new Map(
    (await db.amenities.findMany({ where: { is_active: true }, select: { id: true, slug: true } })).map((a) => [a.slug, a.id])
  )

  /* ── events ───────────────────────────────────────────────────────────── */
  const hotlinked: string[] = []
  for (const spec of EVENTS) {
    const { start, end } = spec.when()
    const venue = VENUES[spec.venue] as VenueSpec
    const media = await mediaFor(spec)
    hotlinked.push(...media.hotlinked)

    const linked = spec.venueLink ? (venueIds[spec.venue] ?? null) : null
    const curatedAt = spec.curated ? new Date(start.getTime() - 21 * 24 * HOUR) : null
    const claimed = spec.curated?.claimed ?? true
    const createdAt = new Date(Math.min(start.getTime(), NOW.getTime()) - 18 * 24 * HOUR)

    const fields = {
      title: spec.title,
      description: spec.description,
      short_description: spec.short,
      latitude: venue.lat,
      longitude: venue.lng,
      address: venue.address,
      venue_name: venue.name,
      venue_id: linked,
      venue_link_status: linked ? (spec.venueLink ?? null) : null,
      city: CITY,
      state: STATE,
      country: COUNTRY,
      postal_code: venue.postal,
      start_time: start,
      end_time: end,
      timezone: TZ,
      status: spec.status ?? "published",
      visibility: spec.visibility ?? "public",
      max_capacity: spec.capacity,
      min_age: spec.minAge ?? null,
      door_policy: spec.door ?? "open",
      deleted_at: spec.deleted ? new Date(NOW.getTime() - 2 * 24 * HOUR) : null,
      // Unclaimed curated events belong to the platform; everything else to the organiser's company.
      organizer_id: spec.curated && !claimed ? admin.id : organiser.id,
      organizer_org_id: spec.curated && !claimed ? null : (eventsOrg?.id ?? null),
      curated_at: curatedAt,
      source_url: spec.curated?.source ?? null,
      claimed_at: spec.curated?.claimed ? new Date(start.getTime() - 10 * 24 * HOUR) : null,
      cover_image_url: media.cover.url,
      external_link: spec.link ?? null,
      is_featured: spec.featured ?? false,
      is_recurring: spec.recurring ?? false,
      check_in_radius: venue.fence.type === "circle" ? venue.fence.radius : 150,
      geofence: venue.fence,
      reminded_at: remindedAt(spec, start),
      pre_suspension_status: null,
    }
    const event = await db.events.upsert({
      where: { slug: spec.slug },
      update: fields,
      create: { slug: spec.slug, ...fields, created_at: createdAt },
    })

    await placeDays(spec, event.id, start, end)

    await db.event_details.upsert({
      where: { event_id: event.id },
      update: detailsOf(spec),
      create: { event_id: event.id, ...detailsOf(spec) },
    })

    // Media: rewritten wholesale — the seed owns these rows.
    await db.event_media.deleteMany({ where: { event_id: event.id } })
    await db.event_media.createMany({
      data: [
        ...(media.clip
          ? [{ event_id: event.id, type: "video" as const, url: media.clip.url, thumbnail_url: media.cover.url, title: media.clip.alt, description: "Last week's set", order: 0 }]
          : []),
        ...media.gallery.map((g, i) => ({
          event_id: event.id,
          type: "image" as const,
          url: g.url,
          thumbnail_url: g.url.replace("w=1600&h=1600", "w=400&h=400"),
          title: g.alt,
          description: null,
          order: i + 1,
        })),
      ],
    })

    await db.event_categories.deleteMany({ where: { event_id: event.id } })
    for (const [i, slug] of spec.categories.entries()) {
      const id = categoryIds.get(slug)
      if (!id) {
        console.log(`  !  category "${slug}" not found — run seed-categories.ts`)
        continue
      }
      await db.event_categories.create({ data: { event_id: event.id, category_id: id, primary: i === 0 } })
    }

    await db.event_amenities.deleteMany({ where: { event_id: event.id } })
    const amenities = spec.amenities.map((s) => amenityIds.get(s)).filter((id): id is string => !!id)
    if (amenities.length) await db.event_amenities.createMany({ data: amenities.map((amenity_id) => ({ event_id: event.id, amenity_id })) })

    await seedSocial(event.id, spec, start, end, { ids, crowdIds, organiserId: organiser.id, orgName: eventsOrg?.display_name ?? "Organiser", sponsorId: sponsor?.id ?? null, adminId: admin.id })

    console.log(`  ✓ ${spec.slug}`)
  }

  if (hotlinked.length) {
    console.log(
      `\n~ ${hotlinked.length} media object(s) are served from Unsplash, not ${SEED_BUCKET}. ` +
        "Fine for testing; run with the Tigris variables to mirror them (docs/agents/TEST-PLAN.md §4)."
    )
  }

  console.log("\nCheck-in pins (set the simulator location to these):")
  for (const spec of EVENTS.filter((e) => !e.status && !e.visibility && !e.deleted)) {
    const v = VENUES[spec.venue] as VenueSpec
    console.log(`    ${spec.slug.padEnd(38)} ${v.lat.toFixed(4)}, ${v.lng.toFixed(4)}`)
  }
  console.log("\nThe feed caches for 30 s — pull to refresh after that.\n")
}

function detailsOf(spec: EventSpec) {
  return {
    full_description: spec.full,
    house_rules: spec.details.houseRules,
    cancellation_policy: spec.details.cancellation,
    covid_guidelines: spec.details.health ?? null,
    faq: spec.details.faq,
    accessibility_info: spec.details.access,
    additional_info: spec.details.extra,
    updated_at: new Date(),
  }
}

/**
 * RSVPs, interest, check-ins, ratings, the room and its sponsor — the rows that
 * make a card say something. Only these events' rows for the seeded people are
 * replaced; a tester's own account is left alone.
 */
async function seedSocial(
  eventId: string,
  spec: EventSpec,
  start: Date,
  end: Date,
  ctx: { ids: (l: Person[] | undefined) => string[]; crowdIds: string[]; organiserId: string; orgName: string; sponsorId: string | null; adminId: string }
) {
  const s = spec.social ?? {}
  const everyone = [...ctx.ids(Object.keys(PEOPLE) as Person[]), ...ctx.crowdIds]

  /*
   * This event's slice of the crowd. The start rotates by slug so each event
   * draws a different mix, and neighbouring events overlap — the same faces
   * turning up at several events is what a real city looks like, and what
   * "repeat attendee" needs to be non-zero.
   */
  const c = s.crowd ?? {}
  const offset = [...spec.slug].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % Math.max(1, ctx.crowdIds.length)
  const rotated = [...ctx.crowdIds.slice(offset), ...ctx.crowdIds.slice(0, offset)]
  const take = (from: number, count = 0) => rotated.slice(from, from + Math.min(count, CROWD_SIZE))
  const crowdGoing = take(0, c.going)
  const crowdWaitlisted = take(crowdGoing.length, c.waitlisted)
  const crowdInterested = take(crowdGoing.length + crowdWaitlisted.length, c.interested)
  const crowdInside = crowdGoing.slice(0, c.inside ?? 0)
  const crowdAttended = crowdGoing.slice(0, c.attended ?? 0)
  const crowdRated = crowdAttended.slice(0, c.rated ?? 0)

  const going = [...ctx.ids(s.going), ...crowdGoing]
  const maybe = ctx.ids(s.maybe)
  const waitlisted = [...ctx.ids(s.waitlisted), ...crowdWaitlisted]
  const favorites = [...ctx.ids(s.favorites), ...crowdInterested]

  await db.event_rsvps.deleteMany({ where: { event_id: eventId, user_id: { in: everyone } } })
  await db.event_favorites.deleteMany({ where: { event_id: eventId, user_id: { in: everyone } } })
  await db.event_ratings.deleteMany({ where: { event_id: eventId, user_id: { in: everyone } } })
  await db.event_match_preferences.deleteMany({ where: { event_id: eventId, user_id: { in: everyone } } })
  await db.presence_sessions.deleteMany({ where: { event_id: eventId, user_id: { in: everyone } } })
  await db.event_check_ins.deleteMany({ where: { event_id: eventId, user_id: { in: everyone } } })
  await db.event_announcements.deleteMany({ where: { event_id: eventId, sent_by: ctx.organiserId } })
  await db.chat_groups.deleteMany({ where: { event_id: eventId } })

  // RSVP'd over the fortnight before, in order — the waitlist promotes by created_at.
  const rsvpAt = (i: number) => new Date(Math.min(start.getTime(), NOW.getTime()) - 14 * 24 * HOUR + i * 5 * HOUR)
  let n = 0
  for (const [status, list] of [["going", going], ["maybe", maybe], ["waitlisted", waitlisted]] as const) {
    for (const user_id of list) {
      const at = rsvpAt(n++)
      await db.event_rsvps.create({ data: { event_id: eventId, user_id, status, created_at: at, updated_at: at } })
    }
  }
  for (const [i, user_id] of favorites.entries()) {
    await db.event_favorites.create({ data: { event_id: eventId, user_id, created_at: rsvpAt(i) } })
  }

  // Check-ins land on the occurrence that holds the moment they arrived.
  // Held days only: a day the event moved off stays cancelled with its old
  // attendance (SCRUM-471), and this run's guests belong on the days it runs.
  const occurrences = await db.event_occurrences.findMany({ where: { event_id: eventId, cancelled_at: null }, orderBy: { start_time: "asc" } })
  const occurrenceAt = (t: Date) =>
    occurrences.find((o) => t >= new Date(o.start_time.getTime() - 90 * MIN) && t <= o.end_time) ?? occurrences[0]
  const arrive = (i: number) => new Date(Math.max(start.getTime(), NOW.getTime() - 3 * HOUR) + i * 3 * MIN)

  const checkedIn = [...ctx.ids(s.checkedIn), ...crowdInside]
  for (const [i, user_id] of checkedIn.entries()) {
    const at = new Date(Math.min(arrive(i).getTime(), NOW.getTime() - 2 * MIN))
    const occ = occurrences.find((o) => NOW >= new Date(o.start_time.getTime() - 90 * MIN) && NOW <= o.end_time) ?? occurrenceAt(at)
    const checkInAt = at < occ.start_time ? occ.start_time : at
    await db.event_check_ins.create({
      data: {
        event_id: eventId,
        occurrence_id: occ.id,
        user_id,
        kind: "attendee",
        status: "checked_in",
        check_in_time: checkInAt,
        latitude: VENUES[spec.venue].lat,
        longitude: VENUES[spec.venue].lng,
        device_info: { platform: i % 2 ? "android" : "ios", source: "seed-blr-scenarios" },
        last_seen_at: new Date(),
      },
    })
    const session = await openSession({ eventId, occurrenceId: occ.id, userId: user_id, at: checkInAt, source: "polling" })
    await db.presence_sessions.update({ where: { id: session.id }, data: { last_seen_at: new Date() } })
    await db.event_match_preferences.create({
      data: { event_id: eventId, user_id, intent: INTENTS[i % INTENTS.length], revealed: i % 3 !== 2 },
    })
  }

  const checkedOut = [...ctx.ids(s.checkedOut), ...crowdAttended]
  for (const [i, user_id] of checkedOut.entries()) {
    const occ = occurrences[0]
    const span = occ.end_time.getTime() - occ.start_time.getTime()
    const inAt = new Date(occ.start_time.getTime() + ((i * 37) % 30) / 100 * span)
    const outAt = new Date(occ.end_time.getTime() - ((i * 53) % 25) / 100 * span)
    await db.event_check_ins.create({
      data: {
        event_id: eventId,
        occurrence_id: occ.id,
        user_id,
        kind: "attendee",
        status: "checked_out",
        check_in_time: inAt,
        check_out_time: outAt,
        latitude: VENUES[spec.venue].lat,
        longitude: VENUES[spec.venue].lng,
        device_info: { platform: i % 2 ? "android" : "ios", source: "seed-blr-scenarios" },
        last_seen_at: outAt,
      },
    })
    await db.presence_sessions.updateMany({ where: { occurrence_id: occ.id, user_id, departed_at: null }, data: { departed_at: outAt, departed_source: "user" } })
    await db.event_match_preferences.create({
      data: { event_id: eventId, user_id, intent: INTENTS[i % INTENTS.length], revealed: true },
    })
  }

  for (const [person, rating, review] of s.ratings ?? []) {
    const [user_id] = ctx.ids([person])
    if (!user_id) continue
    const at = new Date(end.getTime() + 90 * MIN)
    await db.event_ratings.create({ data: { event_id: eventId, user_id, rating, review, created_at: at, updated_at: at } })
  }
  for (const [i, user_id] of crowdRated.entries()) {
    const [rating, review] = CROWD_REVIEWS[(i + offset) % CROWD_REVIEWS.length]
    const at = new Date(end.getTime() + (2 + i * 3) * HOUR)
    await db.event_ratings.create({ data: { event_id: eventId, user_id, rating, review: i % 4 === 3 ? null : review, created_at: at, updated_at: at } })
  }

  if (s.room) {
    const members = [...new Set([...checkedIn, ...checkedOut, ...ctx.ids(s.chat?.map(([p]) => p))])]
    // Named lines first, then the crowd talking, interleaved into the same timeline.
    const talkers = (checkedIn.length ? crowdInside : crowdAttended).slice(0, c.chat ?? 0)
    const lines: [string, string][] = [
      ...(s.chat ?? []).flatMap(([p, t]) => ctx.ids([p]).map((id) => [id, t] as [string, string])),
      ...talkers.map((id, i) => [id, CROWD_CHAT[(i + offset) % CROWD_CHAT.length]] as [string, string]),
    ]
    const archived = s.room === "archived"
    const room = await db.chat_groups.create({
      data: {
        event_id: eventId,
        type: "event",
        name: spec.title,
        description: `The room for everyone at ${spec.title}.`,
        rules: "Be kind. No selling, no spam, no sharing other people's details.",
        status: s.room,
        member_count: archived ? 0 : members.length,
        created_at: new Date(Math.min(start.getTime(), NOW.getTime()) - 20 * HOUR),
      },
    })
    for (const [i, user_id] of members.entries()) {
      await db.chat_group_members.create({
        data: {
          chat_group_id: room.id,
          user_id,
          anonymous_name: handle(i),
          status: archived ? "left" : "active",
          joined_at: new Date(Math.min(start.getTime(), NOW.getTime()) - 60 * MIN + i * 5 * MIN),
        },
      })
    }
    await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: ctx.organiserId, role: "admin", status: archived ? "left" : "active" } })

    // Lines spaced back from the last moment the room was busy.
    const lastAt = new Date(Math.min(NOW.getTime() - 3 * MIN, end.getTime() + 20 * MIN))
    const lineAt = (i: number) => new Date(lastAt.getTime() - (lines.length - i) * 6 * MIN)
    const created: string[] = []
    for (const [i, [user_id, content]] of lines.entries()) {
      const msg = await db.chat_messages.create({
        data: { chat_group_id: room.id, user_id, content, type: "text", moderation_status: "clean", created_at: lineAt(i), updated_at: lineAt(i) },
      })
      created[i] = msg.id
    }
    for (const f of s.feedback ?? []) {
      const message_id = created[f.line]
      if (!message_id) continue
      await db.event_feedback.create({
        data: { event_id: eventId, message_id, sentiment: f.sentiment, category: f.category, confidence: 0.86, source: "lexicon", created_at: lineAt(f.line) },
      })
    }
    let last = lines.length ? lineAt(lines.length - 1) : null
    if (s.announcement) {
      const at = new Date(lastAt.getTime() + MIN)
      const a = await db.event_announcements.create({ data: { event_id: eventId, content: s.announcement, sent_by: ctx.organiserId, created_at: at } })
      await db.chat_messages.create({
        data: {
          chat_group_id: room.id,
          user_id: ctx.organiserId,
          type: "announcement",
          content: `📢 [Announcement from ${ctx.orgName}]\n${s.announcement}`,
          metadata: { announcement_id: a.id },
          is_pinned: true,
          created_at: at,
          updated_at: at,
        },
      })
      last = at
    }
    await db.chat_groups.update({ where: { id: room.id }, data: { last_message_at: last } })
  }

  if (s.sponsor && ctx.sponsorId) {
    await db.event_sponsors.upsert({
      where: { event_id_sponsor_id: { event_id: eventId, sponsor_id: ctx.sponsorId } },
      update: { status: s.sponsor, decided_by: s.sponsor === "approved" ? ctx.adminId : null, decided_at: s.sponsor === "approved" ? new Date(start.getTime() - 5 * 24 * HOUR) : null },
      create: {
        event_id: eventId,
        sponsor_id: ctx.sponsorId,
        status: s.sponsor,
        created_by: ctx.organiserId,
        decided_by: s.sponsor === "approved" ? ctx.adminId : null,
        decided_at: s.sponsor === "approved" ? new Date(start.getTime() - 5 * 24 * HOUR) : null,
      },
    })
  }
}

function fmt(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
