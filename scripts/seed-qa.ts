import { randomBytes } from "node:crypto"

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { PrismaClient, type user_role } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"
import { syncOccurrences } from "../lib/occurrences"
import { storedBodyFor } from "../lib/push-notifications"

/**
 * A world the QA team can actually test against.
 *
 * Two things made the existing setup unusable for a test pass, and both would
 * have produced bug reports against working code.
 *
 * ## 1. A role is not access
 *
 * `lib/rbac.ts` is **organisation-shaped**. `eventPermissions` denies everything
 * when the actor has no memberships:
 *
 *     const orgs = new Set((actor.orgIds ?? []).filter(Boolean))
 *     if (orgs.size === 0) return DENIED          // rbac.ts:95
 *
 * `scripts/create-dashboard-user.ts` creates a user with a role and no
 * organisation. So an organiser account made with it is denied on every event,
 * sees empty screens throughout, and looks exactly like a broken dashboard.
 *
 * This seeds the orgs and the memberships, which is what actually grants access:
 *
 *     Nightshift Collective   ← organiser is a member.   Runs the events.
 *     Indiranagar Hospitality Group   ← venue owner is a member. Owns the buildings.
 *
 * Those two being **separate** is the point. It is the only way to test the row
 * that is easiest to get wrong: a venue owner may *operate* an event in their
 * building — chat, moderation, attendees — and may **not** edit it.
 *
 * ## 2. One event, in one city, tests almost nothing
 *
 * The city picker, "coming soon", age gating, nightlife, distance sorting and
 * polygon check-in are all unexercisable against a single Bengaluru event. The
 * world below exists so each of those has both a positive and a negative case —
 * a suite where everything passes by default is not a suite.
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/seed-qa.ts            # dry run
 *   DATABASE_URL=... npx tsx scripts/seed-qa.ts --apply
 *
 * Idempotent: emails and slugs are stable, so re-running resets passwords and
 * leaves the world where it was rather than duplicating it.
 *
 * **Staging only.** It prints the database host before doing anything so a
 * misdirected run is visible before it writes, not after.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

const APPLY = process.argv.includes("--apply")

/**
 * Same generator and cost as `create-dashboard-user.ts`, deliberately.
 *
 * `SEED_PASSWORD` overrides it with one fixed value for every account.
 *
 * Random-per-run is right for a real credential and wrong for this one. Every
 * re-seed rotated all four passwords, which meant the Jira ticket testers read
 * them from (SCRUM-1) went stale the moment anybody refreshed the world — and a
 * tester whose password silently stopped working files a bug against sign-in.
 * The rotation was protecting staging accounts that exist only on staging and
 * whose passwords are already written down in a ticket.
 *
 * Still opt-in: without the variable this behaves exactly as before, so nothing
 * acquires a fixed password by accident. **Staging only** — the script refuses
 * to be pointed anywhere else by printing its host first.
 */
const generatePassword = () =>
  process.env.SEED_PASSWORD?.trim() || randomBytes(18).toString("base64url")
const HASH_COST = 12

/* -------------------------------------------------------------------------- */
/* The world                                                                   */
/* -------------------------------------------------------------------------- */

const CITY = {
  bengaluru: { name: "Bengaluru", lat: 12.9716, lng: 77.5946, tz: "Asia/Kolkata" },
  mumbai: { name: "Mumbai", lat: 19.076, lng: 72.8777, tz: "Asia/Kolkata" },
  /** Saarbrücken, because that is where the reporter is — it makes the
   *  "you're in X, switch?" banner and the resume policy testable at all. */
  saarbruecken: { name: "Saarbrücken", lat: 49.2402, lng: 6.9969, tz: "Europe/Berlin" },
} as const

const ACCOUNTS = [
  /*
   * The three product owners, by name.
   *
   * A shared generic admin means a board full of actions nobody can attribute
   * -- the audit log records who did a thing, and "Priya Menon" is nobody.
   * These are the accounts the people running the product actually sign in as.
   */
  {
    key: "sagar",
    email: "sagar.kishore@blendn.app",
    name: "Sagar Kishore",
    role: "app_admin" as user_role,
    org: null,
    note: "Product owner. Full admin.",
  },
  {
    key: "hemanth",
    email: "hemanth.ramesh@blendn.app",
    name: "Hemanth Ramesh",
    role: "app_admin" as user_role,
    org: null,
    note: "Product owner. Full admin.",
  },
  {
    key: "likhith",
    email: "likhith.gowda@blendn.app",
    name: "Likhith Gowda",
    role: "app_admin" as user_role,
    org: null,
    note: "Product owner. Full admin.",
  },
  {
    key: "admin",
    email: "priya.menon@blendn.app",
    name: "Priya Menon",
    role: "app_admin" as user_role,
    org: null,
    note: "Sees everything. eventPermissions short-circuits before org checks.",
  },
  {
    key: "organiser",
    email: "arjun.rao@blendn.app",
    name: "Arjun Rao",
    role: "organizer" as user_role,
    org: "events" as const,
    note: "Member of the org that RUNS the events. May edit and operate them.",
  },
  {
    key: "venue",
    email: "fatima.sheikh@blendn.app",
    name: "Fatima Sheikh",
    role: "venue_owner" as user_role,
    org: "venues" as const,
    note: "Member of the org that OWNS the buildings. May operate, must NOT edit.",
  },
  {
    key: "outsider",
    email: "daniel.weber@blendn.app",
    name: "Daniel Weber",
    role: "organizer" as user_role,
    org: null,
    /**
     * The negative control, and the account most likely to be mistaken for a
     * bug. It has a dashboard role and no organisation, so every event denies
     * it. That is correct behaviour and there must be an account that proves it
     * — otherwise "organiser can edit" passes without anyone checking that
     * "some other organiser cannot".
     */
    note: "NEGATIVE CONTROL. Dashboard role, no org — must be denied on every event.",
  },
  /*
   * The fifth role, and the one with no fixture at all until now.
   *
   * `getDashboardOverview` branches on app_admin and venue_owner, then falls
   * through to the organiser query scoped to `organizer_id = <this user>` — so
   * a sponsor's home screen is permanently all-zero. That cannot be seen, let
   * alone fixed, without an account to sign in as.
   */
  {
    key: "sponsor",
    email: "meera.iyer@blendn.app",
    name: "Meera Iyer",
    role: "sponsor" as user_role,
    org: "brands" as const,
    note: "Member of the org that BUYS placements. Brand, placements, charges.",
  },
] as const

/**
 * People to fill the rooms.
 *
 * Attendees are mobile-only — `canAccessDashboard` bounces them — but nothing
 * about chat, matching, check-in, occupancy or any organiser number can be
 * exercised without real rows behind them. Six is enough to cross the
 * disclosure floor of five and still have a room that sits under it.
 */
const ATTENDEES = [
  { email: "ananya.b@blendn.app", name: "Ananya Bhat", age: 27 },
  { email: "rohan.d@blendn.app", name: "Rohan Desai", age: 31 },
  { email: "kavya.n@blendn.app", name: "Kavya Nair", age: 24 },
  { email: "imran.q@blendn.app", name: "Imran Qureshi", age: 29 },
  { email: "sneha.p@blendn.app", name: "Sneha Pillai", age: 35 },
  { email: "vikram.s@blendn.app", name: "Vikram Shetty", age: 22 },
  /* Under 18, so the age gate has something to refuse rather than only
     something to admit. */
  { email: "teen.tester@blendn.app", name: "Aarav Menon", age: 16 },
] as const

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000)

/**
 * Each row exists to make one thing testable, and several exist to make a
 * *failure* testable — a draft and a private event must never reach an
 * attendee, and there is no way to prove that without seeding them.
 */
const EVENTS = [
  { slug: "sunset-sessions-humming-tree", title: "Sunset Sessions at The Humming Tree",
    city: "bengaluru", venue: "circle",
    startsIn: 48, hours: 3, status: "published", visibility: "public", media: "rooftop", minAge: null,
    category: "music-live-gigs", why: "The everything-works case. Circle geofence, cover image, future." },
  { slug: "premier-league-chinnaswamy", title: "Premier League Screening — Chinnaswamy",
    city: "bengaluru", venue: "polygon",
    startsIn: 72, hours: 4, status: "published", visibility: "public", media: "stadium", minAge: null,
    category: "sports-football-screening",
    why: "Polygon check-in, and the shortfall message for a non-circular venue." },
  { slug: "after-hours-neon-cathedral", title: "After Hours: Neon Cathedral",
    city: "bengaluru", venue: "circle",
    startsIn: 96, hours: 5, status: "published", visibility: "public", media: "neon", minAge: 18,
    category: "nightlife-parties", why: "Age gating. Must be hidden from an under-18 profile." },
  { slug: "basement-six-residents", title: "Basement Six — Resident DJs",
    city: "bengaluru", venue: "circle",
    startsIn: 120, hours: 4, status: "published", visibility: "public", media: "club", minAge: null,
    category: "nightlife-dj-sets", why: "The Nightlife section, which groups on the PARENT slug." },
  { slug: "morning-ragas-chowdiah", title: "Morning Ragas at Chowdiah",
    city: "bengaluru", venue: "circle",
    startsIn: 130, hours: 2, status: "published", visibility: "public", media: "recital", minAge: null,
    category: "music-classical-and-carnatic",
    why: "Must NOT appear under Nightlife. The old substring match filed it as a party." },
  { slug: "koramangala-open-mic", title: "Koramangala Open Mic",
    city: "bengaluru", venue: "circle",
    startsIn: 60, hours: 2, status: "published", visibility: "public", media: null, minAge: null,
    category: "music-open-mic", why: "The coverless card. Used to render as an empty grey rectangle." },
  { slug: "founders-filter-coffee", title: "Founders & Filter Coffee",
    city: "bengaluru", venue: "circle",
    startsIn: -0.5, hours: 3, status: "published", visibility: "public", media: "coffee", minAge: null,
    category: "networking-founders", why: "Check-in is only possible while an event is on." },
  { slug: "monsoon-flea-market", title: "Monsoon Flea Market",
    city: "bengaluru", venue: "circle",
    startsIn: -200, hours: 3, status: "published", visibility: "public", media: "market", minAge: null,
    category: "markets-fairs-flea-markets",
    why: "Must NOT appear in discovery. Only with includePast." },
  { slug: "diwali-rooftop-unannounced", title: "Diwali Rooftop",
    city: "bengaluru", venue: "circle",
    startsIn: 80, hours: 2, status: "draft", visibility: "public", media: "rooftop", minAge: null,
    category: null, why: "NEGATIVE. A draft reaching an attendee is a leak, not a display bug." },
  { slug: "private-listening-session", title: "Private Listening Session",
    city: "bengaluru", venue: "circle",
    startsIn: 85, hours: 2, status: "published", visibility: "private", media: "club", minAge: null,
    category: null, why: "NEGATIVE. Same class as the draft." },
  { slug: "bandra-supper-club", title: "Bandra Supper Club", city: "mumbai", venue: null,
    startsIn: 50, hours: 3, status: "published", visibility: "public", media: "supper", minAge: null,
    category: "food-drink-supper-clubs",
    why: "A second city. Without one, the picker cannot be tested at all." },
  { slug: "saarbruecken-language-exchange", title: "Saarbrücken Language Exchange",
    city: "saarbruecken", venue: null,
    startsIn: 55, hours: 3, status: "published", visibility: "public", media: "language", minAge: null,
    category: "community-language-exchange",
    why: "Makes the switch banner and the resume policy testable from a device in Germany." },

  /*
   * The two the world was missing.
   *
   * A multi-day event is the only way to exercise occurrences — `findFirst` on
   * a per-event key is nondeterministic across days, which is the bug that
   * moved per-event preferences into their own table.
   *
   * And a Social event exercises the parent this product exists for. Without
   * one, the category most likely to be filtered on has nothing behind it.
   */
  { slug: "design-week-bengaluru", title: "Design Week Bengaluru", city: "bengaluru", venue: "circle",
    startsIn: 168, hours: 30, status: "published", visibility: "public", media: "design", minAge: null,
    category: "arts-culture-exhibitions",
    why: "Multi-day. Occurrences, and the per-day check-in key." },
  { slug: "speed-dating-church-street", title: "Speed Dating on Church Street",
    city: "bengaluru", venue: "circle",
    startsIn: 90, hours: 2, status: "published", visibility: "public", media: "social", minAge: 18,
    category: "social-speed-dating",
    why: "The Social parent — the category this product is actually for." },
] as const

/**
 * A distinct asset per event, at the size `docs/MEDIA.md` specifies.
 *
 * One shared cover across every row was the previous state, and it hid two
 * whole classes of problem: you cannot see a crop going wrong when every card
 * crops the same photograph, and you cannot tell a card that failed to load
 * from one that loaded the same image as its neighbour.
 *
 * Square at 2048, so it is the master shape organisers are asked for rather
 * than a shape that happens to fit one slot. Chosen by subject — see `cover`.
 */
/**
 * Rows this script created under its previous names, retired on sight.
 *
 * The upsert key is the slug, so renaming `qa-baseline-blr` to
 * `sunset-sessions-humming-tree` did not rename anything — it created a second
 * event and left the first one published. Staging ended up with both, and the
 * feed showed "QA Baseline — Bengaluru" next to the event that replaced it.
 *
 * Soft-deleted rather than destroyed: `deleted_at` is what every read path
 * already filters on, and a hard delete would cascade through check-ins and
 * chat that a tester may be halfway through looking at.
 *
 * This list is disposable. Once no environment has these slugs it can go, and
 * anything still here is an environment nobody has re-seeded.
 */
const RETIRED_SLUGS = [
  "qa-baseline-blr",
  "qa-polygon-stadium",
  "qa-age-gated",
  "qa-nightlife",
  "qa-classical",
  "qa-no-cover",
  "qa-live-now",
  "qa-ended",
  "qa-draft",
  "qa-private",
  "qa-mumbai",
  "qa-saarbruecken",
]

/**
 * Which events serve their media from **our** bucket rather than someone else's.
 *
 * Both paths have to be testable because both will exist. An organiser
 * uploading a file produces a Tigris URL; an organiser pasting a link (once the
 * dashboard offers that — it does not yet, see the media editor task) produces
 * a foreign one. They fail differently: a foreign URL can 404, rate-limit, go
 * HTTP-only or vanish, and none of that can happen to a bucket we own.
 *
 * A world seeded entirely one way tests half the product. These slugs are
 * mirrored into Tigris; everything else stays hotlinked.
 */
const TIGRIS_HOSTED = new Set([
  "sunset-sessions-humming-tree",
  "after-hours-neon-cathedral",
  "morning-ragas-chowdiah",
  "founders-filter-coffee",
  "bandra-supper-club",
  "design-week-bengaluru",
])

/**
 * Copy a remote asset into our bucket and hand back the public URL.
 *
 * Returns the original URL unchanged when Tigris is not configured or the copy
 * fails, and says so. A seed that dies because an object store was unreachable
 * would leave the world half-built, which is worse than a world where six
 * events are hotlinked and the log explains why.
 */
async function mirrorToTigris(
  sourceUrl: string,
  key: string,
  contentType: string
): Promise<string> {
  const endpoint = process.env.TIGRIS_ENDPOINT
  const accessKeyId = process.env.TIGRIS_ACCESS_KEY
  const secretAccessKey = process.env.TIGRIS_SECRET_KEY
  const bucket = process.env.TIGRIS_BUCKET || "blendn-media"
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.log(`  ~  Tigris not configured — ${key} stays hotlinked`)
    return sourceUrl
  }

  try {
    const res = await fetch(sourceUrl, { redirect: "follow" })
    if (!res.ok) throw new Error(`source ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())

    const client = new S3Client({
      endpoint,
      region: process.env.TIGRIS_REGION || "auto",
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: false,
    })
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Long, because a seeded asset never changes under its key — the key
        // carries the event slug, so a new asset is a new key.
        CacheControl: "public, max-age=31536000, immutable",
      })
    )
    return `https://${bucket}.fly.storage.tigris.dev/${key}`
  } catch (error) {
    console.log(`  ~  mirror failed for ${key} (${String(error)}) — staying hotlinked`)
    return sourceUrl
  }
}

/**
 * A square 2048 master per `docs/MEDIA.md`, chosen **by subject**.
 *
 * This was `picsum.photos` seeded by name: unique per event and stable across
 * runs, which caught a broken crop and nothing else — the photographs are
 * arbitrary stock, so "Speed Dating on Church Street" showed a landscape and
 * the cards could not be judged as design at all.
 *
 * `loremflickr` takes keywords, so a nightclub event gets a photograph of a
 * nightclub. `lock` is derived from the subject, so the same event keeps the
 * same photograph and a screenshot diff still means something.
 *
 * `source.unsplash.com` was the obvious choice and is retired — it 503s. Worth
 * recording so nobody reaches for it again.
 *
 * **Staging only, and third-party.** These are Flickr photographs chosen by a
 * keyword, so what comes back is not curated by us. Fine for a test environment
 * that only internal testers see; production media is what an organiser
 * uploads.
 */
const cover = (seed: string) =>
  `https://loremflickr.com/2048/2048/${MEDIA_SUBJECT[seed] ?? "event"}?lock=${lockFor(seed)}`

/** A stable number per subject, so the same slug gets the same photograph. */
const lockFor = (seed: string) =>
  [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7)

/** What each event's photograph should be *of*. */
const MEDIA_SUBJECT: Record<string, string> = {
  rooftop: "rooftop,party,sunset",
  stadium: "stadium,football,crowd",
  neon: "nightclub,neon,lights",
  club: "dj,nightclub,dancing",
  recital: "concert,classical,music",
  coffee: "cafe,coffee,people",
  market: "market,street,stalls",
  supper: "dinner,restaurant,table",
  language: "cafe,conversation,friends",
  design: "exhibition,gallery,design",
  social: "friends,bar,conversation",
}

/**
 * Clips, on two events rather than all of them.
 *
 * A feed where every card plays is not the feed anybody will have, and it hides
 * the case that actually needs testing: a still card next to a playing one,
 * which is where a mismatched poster or a wrong aspect shows up.
 */
const CLIPS: Record<string, string> = {
  "sunset-sessions-humming-tree":
    "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4",
  "basement-six-residents":
    "https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4",
}
/* -------------------------------------------------------------------------- */

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host
    } catch {
      return "(unparseable DATABASE_URL)"
    }
  })()

  console.log(`\ndatabase: ${host}`)
  console.log(APPLY ? "mode:     APPLY — this will write\n" : "mode:     dry run\n")

  if (!APPLY) {
    console.log("Would create:")
    console.log(`  3 organisations, ${ACCOUNTS.length} dashboard accounts, ${ATTENDEES.length} attendees,`)
    console.log(`  3 venues, ${EVENTS.length} events, plus curated events, claims in every state,`)
    console.log(`  applications in every state, check-ins, chat, sponsors and city demand`)
    for (const a of ACCOUNTS) console.log(`    ${a.role.padEnd(12)} ${a.email}`)
    for (const e of EVENTS) console.log(`    ${e.slug.padEnd(22)} ${e.why}`)
    console.log("\nRe-run with --apply to write.\n")
    return
  }

  // ── organisations ────────────────────────────────────────────────────────
  const orgs = {
    events: await upsertOrg("Nightshift Collective"),
    venues: await upsertOrg("Indiranagar Hospitality Group"),
    brands: await upsertOrg("Blue Tokai Coffee Roasters"),
  }

  // ── accounts ─────────────────────────────────────────────────────────────
  const created: { email: string; password: string; role: string; org: string; note: string }[] = []
  const users: Record<string, string> = {}

  for (const account of ACCOUNTS) {
    const password = generatePassword()
    const hashed = await bcrypt.hash(password, HASH_COST)

    const user = await db.user.upsert({
      where: { email: account.email },
      update: { password: hashed, role: account.role, deletedAt: null, suspended_at: null },
      create: {
        email: account.email,
        name: account.name,
        password: hashed,
        role: account.role,
        emailVerified: new Date(),
      },
    })
    users[account.key] = user.id

    /*
     * A profile with an age, because the mobile side needs one and because age
     * gating cannot be tested without a viewer whose age is known. 30 clears
     * every `min_age` the seed uses; testing the *refusal* means editing this
     * profile down, which the ticket says to do rather than seeding a second
     * account nobody would remember to keep in step.
     */
    await db.profiles.upsert({
      where: { id: user.id },
      update: {},
      create: { id: user.id, name: account.name, age: 30 },
    })

    if (account.org) {
      const orgId = orgs[account.org].id
      await db.organisation_members.upsert({
        where: { org_id_user_id: { org_id: orgId, user_id: user.id } },
        update: { role: "owner" },
        create: { org_id: orgId, user_id: user.id, role: "owner", is_primary_contact: true },
      })
    }

    created.push({
      email: account.email,
      password,
      role: account.role,
      org: account.org ? orgs[account.org].display_name : "— none —",
      note: account.note,
    })
  }

  // ── venues ───────────────────────────────────────────────────────────────
  const blr = CITY.bengaluru
  const circle = await upsertVenue({
    slugName: "The Humming Tree",
    city: blr.name,
    lat: blr.lat,
    lng: blr.lng,
    ownerOrgId: orgs.venues.id,
    ownerId: users.venue,
    geofence: { type: "circle", lat: blr.lat, lng: blr.lng, radius: 40, buffer: 20 },
  })
  const polygon = await upsertVenue({
    slugName: "M. Chinnaswamy Stadium",
    city: blr.name,
    lat: 12.9788,
    lng: 77.5996,
    ownerOrgId: orgs.venues.id,
    ownerId: users.venue,
    // ~200m square. Big enough that a centre-point radius would be wrong, which
    // is the whole reason polygons exist.
    geofence: {
      type: "polygon",
      buffer: 25,
      ring: [
        [12.9779, 77.5987],
        [12.9797, 77.5987],
        [12.9797, 77.6005],
        [12.9779, 77.6005],
      ],
    },
  })
  const unclaimed = await upsertVenue({
    slugName: "Church Street Social",
    city: blr.name,
    lat: 12.965,
    lng: 77.59,
    ownerOrgId: null,
    ownerId: null,
    geofence: null,
  })

  // ── events ───────────────────────────────────────────────────────────────
  for (const spec of EVENTS) {
    /*
     * Half the world serves its media from our bucket, half from someone
     * else's — see `TIGRIS_HOSTED`. Both paths exist in the product and they
     * fail differently, so a world seeded entirely one way tests half of it.
     */
    const coverUrl = spec.media
      ? TIGRIS_HOSTED.has(spec.slug) && APPLY
        ? await mirrorToTigris(cover(spec.media), `seed/${spec.slug}/cover.jpg`, "image/jpeg")
        : cover(spec.media)
      : null

    const city = CITY[spec.city as keyof typeof CITY]
    const venue = spec.venue === "circle" ? circle : spec.venue === "polygon" ? polygon : null
    const start = hoursFromNow(spec.startsIn)

    const event = await db.events.upsert({
      where: { slug: spec.slug },
      update: {
        title: spec.title,
        start_time: start,
        end_time: hoursFromNow(spec.startsIn + spec.hours),
        status: spec.status as never,
        visibility: spec.visibility as never,
        min_age: spec.minAge,
        /*
         * The media, on **update** as well as create.
         *
         * This clause used to carry only the times and the flags, so an event's
         * cover was written once when the row was born and never again. Every
         * later run refreshed the dates and left the picture — which is how a
         * world "reseeded" three times still served the images from the first
         * run, and why swapping the image source appeared to do nothing at all.
         *
         * The symptom is the worst kind: the script prints success, the dates
         * really did move, and only the pictures are stale.
         */
        cover_image_url: coverUrl,
        deleted_at: null,
      },
      create: {
        slug: spec.slug,
        title: spec.title,
        description: `${spec.why}\n\nSeeded by scripts/seed-qa.ts. Safe to modify.`,
        start_time: start,
        end_time: hoursFromNow(spec.startsIn + spec.hours),
        timezone: city.tz,
        status: spec.status as never,
        visibility: spec.visibility as never,
        min_age: spec.minAge,
        cover_image_url: coverUrl,
        city: city.name,
        latitude: venue?.latitude ?? city.lat,
        longitude: venue?.longitude ?? city.lng,
        geofence: venue?.geofence ?? undefined,
        check_in_radius: 60,
        venue_id: venue?.id ?? null,
        venue_name: venue?.name ?? `${city.name} public space`,
        organizer_id: users.organiser,
        organizer_org_id: orgs.events.id,
      },
    })

    /*
     * Occurrences, through the same writer the product uses.
     *
     * `resolveOccurrence` is what check-in asks "which day is this?", and it
     * answers `none` for an event with no occurrence rows. The route treats
     * `none` as `too_late` — so **an event two days in the future refused
     * check-in with "Event has already ended"**, and recorded the refusal as
     * `too_late`, which is a real signal on the curation-health screen.
     *
     * The route's comment says every event has at least one occurrence and it
     * is right about the product: `POST /api/events` calls `syncOccurrences`.
     * It was wrong about the seeded world, because this script wrote `events`
     * rows directly and only built occurrences for the two it wanted check-ins
     * on. So the fixture quietly disagreed with the thing it exists to
     * represent, in the one mechanic the product cannot do without.
     *
     * Calling the real writer rather than inserting rows here is the point: a
     * fixture that hand-rolls what production computes is a second
     * implementation, and it will drift again.
     */
    await syncOccurrences(
      event.id,
      start,
      hoursFromNow(spec.startsIn + spec.hours),
      city.tz
    )

    /*
     * The clip, as an `event_media` row rather than a column.
     *
     * `event_media` has carried `type: image | video | document`, a `url`, a
     * `thumbnail_url` and an `order` all along, and `GET /events` serves all
     * five — so video needed no schema change. The app reads the first `video`
     * row via `lib/feedMedia.ts`.
     *
     * `thumbnail_url` is the event's own cover, and it is **not optional**:
     * `feedClip` refuses to play a clip it cannot poster, so a video row seeded
     * without one would simply never appear and look like a broken player.
     */
    const clip = CLIPS[spec.slug]
    if (clip && spec.media) {
      const existing = await db.event_media.findFirst({
        where: { event_id: event.id, type: "video" },
      })
      const clipUrl =
        TIGRIS_HOSTED.has(spec.slug) && APPLY
          ? await mirrorToTigris(clip, `seed/${spec.slug}/clip.mp4`, "video/mp4")
          : clip
      const data = {
        event_id: event.id,
        type: "video" as const,
        url: clipUrl,
        // The poster is the event's own cover, resolved the same way — a
        // Tigris-hosted clip with a hotlinked poster would be a mixed case
        // nobody asked for.
        thumbnail_url: coverUrl,
        order: 0,
      }
      if (existing) await db.event_media.update({ where: { id: existing.id }, data })
      else await db.event_media.create({ data })
    }

    if (spec.category) {
      const category = await db.categories.findUnique({ where: { slug: spec.category } })
      if (category) {
        await db.event_categories.upsert({
          where: { event_id_category_id: { event_id: event.id, category_id: category.id } },
          update: { primary: true },
          create: { event_id: event.id, category_id: category.id, primary: true },
        })
      } else {
        // Not fatal: the taxonomy may not be seeded here. Say so rather than
        // silently producing an event that will fail its category test.
        console.log(`  !  category "${spec.category}" not found — run seed:categories`)
      }
    }
  }

  // ── attendees ────────────────────────────────────────────────────────────
  /*
   * Seeded with a profile and an age, because every gate downstream reads one.
   * Not printed with individual passwords below -- they share the seed password
   * and a tester needs the list, not seven credential blocks.
   */
  const attendeeIds: string[] = []
  for (const a of ATTENDEES) {
    const hashed = await bcrypt.hash(generatePassword(), HASH_COST)
    const u = await db.user.upsert({
      where: { email: a.email },
      update: { role: "attendee", deletedAt: null, suspended_at: null },
      create: {
        email: a.email,
        name: a.name,
        password: hashed,
        role: "attendee",
        emailVerified: new Date(),
      },
    })
    /*
     * `onboarded: true`, because the activation funnel's stages are nested
     * subsets on purpose -- "checked in" counts users who are onboarded AND
     * RSVP'd AND checked in. Seed only the check-ins and every stage below the
     * first reads zero, which looks like a broken funnel rather than a thin
     * world.
     */
    await db.profiles.upsert({
      where: { id: u.id },
      update: { age: a.age, onboarded: true },
      create: { id: u.id, name: a.name, age: a.age, onboarded: true },
    })
    attendeeIds.push(u.id)
  }

  // ── check-ins, so the numbers have rows to count ─────────────────────────
  /*
   * `event_check_ins.occurrence_id` is NOT NULL, so an occurrence has to exist
   * first. The product creates them lazily through `resolveOccurrence`; here
   * they are written directly, keyed on the event's own start date.
   *
   * Two events get them, deliberately:
   *
   *   founders-filter-coffee  is happening NOW  -> live occupancy, the ops tick
   *   monsoon-flea-market     finished          -> turn-up, no-show, repeat
   *
   * Six people at the live one and four at the finished one, with one person in
   * both -- so "came back for a 2nd event" has exactly one true answer, which
   * is the figure that read wrong for the product's whole life.
   */
  const occurrenceFor = async (slug: string) => {
    const ev = await db.events.findUnique({
      where: { slug },
      select: { id: true, start_time: true, end_time: true },
    })
    if (!ev) return null
    const day = new Date(
      Date.UTC(ev.start_time.getUTCFullYear(), ev.start_time.getUTCMonth(), ev.start_time.getUTCDate())
    )
    const existing = await db.event_occurrences.findFirst({
      where: { event_id: ev.id, occurs_on: day },
    })
    if (existing) return { event: ev, occurrence: existing }
    const occurrence = await db.event_occurrences.create({
      data: { event_id: ev.id, occurs_on: day, start_time: ev.start_time, end_time: ev.end_time },
    })
    return { event: ev, occurrence }
  }

  const checkInto = async (slug: string, userIds: string[], status: "checked_in" | "checked_out") => {
    const slot = await occurrenceFor(slug)
    if (!slot) return 0
    let n = 0
    for (const userId of userIds) {
      await db.event_check_ins.upsert({
        where: {
          occurrence_id_user_id: { occurrence_id: slot.occurrence.id, user_id: userId },
        },
        update: { status },
        create: {
          event_id: slot.event.id,
          occurrence_id: slot.occurrence.id,
          user_id: userId,
          kind: "attendee",
          status,
          check_in_time: slot.event.start_time,
          check_out_time: status === "checked_out" ? slot.event.end_time : null,
        },
      })
      n++
    }
    return n
  }

  /*
   * RSVPs before check-ins, and deliberately MORE of them.
   *
   * Turn-up is attended / committed, so a world where everyone who RSVP'd also
   * came makes it permanently 100% and unfalsifiable. Two people say going and
   * do not turn up, which is what makes no-show a number rather than a zero.
   */
  const rsvpTo = async (slug: string, userIds: string[], status: "going" | "maybe" = "going") => {
    const ev = await db.events.findUnique({ where: { slug }, select: { id: true } })
    if (!ev) return 0
    let n = 0
    for (const userId of userIds) {
      await db.event_rsvps.upsert({
        where: { event_id_user_id: { event_id: ev.id, user_id: userId } },
        update: { status },
        create: { event_id: ev.id, user_id: userId, status },
      })
      n++
    }
    return n
  }
  const _rsvps =
    (await rsvpTo("founders-filter-coffee", attendeeIds)) +
    (await rsvpTo("sunset-sessions-humming-tree", attendeeIds.slice(0, 4), "maybe"))

  const _liveCheckIns = await checkInto("founders-filter-coffee", attendeeIds.slice(0, 6), "checked_in")
  // Person 0 is in both, and is the only true repeat attendee in the world.
  const _pastCheckIns = await checkInto("monsoon-flea-market", [attendeeIds[0], ...attendeeIds.slice(6)], "checked_out")

  /*
   * Somebody who attended TWO DAYS of one event.
   *
   * `event_check_ins` holds one row per person per day, and nine dashboard
   * sites once counted rows and called them people — so every figure on a
   * multi-day event was multiplied by the day count. W17 fixed it, and a
   * fixture only *proves* it stayed fixed if somebody in it attended twice.
   *
   * On a single-day world `rows == people`, and every assertion about counting
   * passes against code that counts either. `e2e/attendance-numbers.spec.ts`
   * refuses to run without this, which is how its absence was noticed: the
   * previous world produced two rows per person only because two write paths
   * disagreed about which occurrence a check-in belonged to, and that artifact
   * disappeared the moment the seed started building occurrences properly.
   *
   * Design Week is the only genuinely multi-day event here — a span, so
   * `syncOccurrences` gives it a real occurrence per day rather than one
   * invented for the fixture.
   */
  const multiDay = await db.events.findUnique({
    where: { slug: "design-week-bengaluru" },
    select: { id: true, start_time: true },
  })
  let _multiDayCheckIns = 0
  if (multiDay) {
    const days = await db.event_occurrences.findMany({
      where: { event_id: multiDay.id },
      orderBy: { occurs_on: "asc" },
      take: 2,
    })
    // The same two people on both days: 4 rows, 2 people. Anything that
    // reports 4 is counting rows.
    for (const day of days) {
      for (const userId of attendeeIds.slice(0, 2)) {
        await db.event_check_ins.upsert({
          where: { occurrence_id_user_id: { occurrence_id: day.id, user_id: userId } },
          update: { status: "checked_out" },
          create: {
            event_id: multiDay.id,
            occurrence_id: day.id,
            user_id: userId,
            kind: "attendee",
            status: "checked_out",
            check_in_time: day.start_time,
            check_out_time: day.end_time,
          },
        })
        _multiDayCheckIns++
      }
    }
  }

  // ── a room with something in it ──────────────────────────────────────────
  const liveEvent = await db.events.findUnique({
    where: { slug: "founders-filter-coffee" },
    select: { id: true, title: true },
  })
  if (liveEvent) {
    const room = await db.chat_groups.upsert({
      where: { event_id: liveEvent.id },
      update: {},
      create: { event_id: liveEvent.id, name: liveEvent.title, type: "event" },
    })
    /*
     * Pseudonyms live on `chat_group_members`, uniquely per room. Seeded
     * explicitly rather than left to the generator, so the world is stable
     * across runs and a screenshot in a bug report still matches.
     */
    const HANDLES = ["Cosmic Panda", "Quiet Otter", "Amber Fox", "Still Heron", "Vivid Moth", "Slow Comet"]
    const lines = [
      "anyone else here for the filter coffee or just me",
      "the corner table is free if anyone wants it",
      "second round is on me",
      "who is doing the talk at 4",
      "great turnout for a tuesday",
      "reach me on 98450 12345 if you get lost",
    ]
    for (let i = 0; i < Math.min(attendeeIds.length, HANDLES.length); i++) {
      await db.chat_group_members.upsert({
        where: { chat_group_id_user_id: { chat_group_id: room.id, user_id: attendeeIds[i] } },
        update: {},
        create: { chat_group_id: room.id, user_id: attendeeIds[i], anonymous_name: HANDLES[i] },
      })
      const existing = await db.chat_messages.findFirst({
        where: { chat_group_id: room.id, user_id: attendeeIds[i], content: lines[i] },
      })
      if (!existing) {
        await db.chat_messages.create({
          data: { chat_group_id: room.id, user_id: attendeeIds[i], content: lines[i] },
        })
      }
    }
    /*
     * The last line carries a phone number on purpose. `lib/moderation
     * /contact-info.ts` exists to spot exactly that, and a moderation queue
     * with nothing in it cannot be tested.
     */
  }

  // ── curated events, so the claim funnel has something to claim ───────────
  /*
   * `curated_at IS NOT NULL` is the discriminator, and it has to be: a null
   * `organizer_org_id` means three different things, and offering a legacy row
   * for claiming would let a stranger claim a real organiser's event.
   */
  const CURATED = [
    { slug: "seeded-curated-open", title: "Indie Sundowner at Toit", claimed: false, dead: false,
      why: "Curated and unclaimed. The claim funnel's happy path." },
    { slug: "seeded-curated-dead", title: "Terrace Jazz at Bob's Bar", claimed: false, dead: true,
      why: "Ended with nobody in, and people were turned away — a wrong pin." },
    { slug: "seeded-curated-claimed", title: "Vinyl Night at The Permit Room", claimed: true, dead: false,
      why: "Already claimed. A second claim must be refused." },
  ]
  const curatedIds: Record<string, string> = {}
  for (const c of CURATED) {
    const start = hoursFromNow(c.dead ? -120 : 90)
    const ev = await db.events.upsert({
      where: { slug: c.slug },
      update: { deleted_at: null },
      create: {
        slug: c.slug,
        title: c.title,
        description: `${c.title} at Bengaluru. Listed by Blendn from a public listing — see the source for details and tickets.`,
        start_time: start,
        end_time: new Date(start.getTime() + 4 * 3_600_000),
        timezone: CITY.bengaluru.tz,
        status: "published",
        visibility: "public",
        city: CITY.bengaluru.name,
        latitude: CITY.bengaluru.lat,
        longitude: CITY.bengaluru.lng,
        check_in_radius: 250,
        venue_name: c.title.split(" at ")[1] ?? null,
        organizer_id: users.sagar,
        organizer_org_id: c.claimed ? orgs.events.id : null,
        curated_at: hoursFromNow(-400),
        claimed_at: c.claimed ? hoursFromNow(-40) : null,
        source_url: `https://in.bookmyshow.com/events/${c.slug}`,
      },
    })

    // Same reason as the main event loop above: without occurrences the
    // check-in route answers "Event has already ended" for a future event, and
    // a curated event that cannot be checked into is the one case where that
    // silence is indistinguishable from the wrong-pin signal curation exists
    // to measure.
    await syncOccurrences(ev.id, start, new Date(start.getTime() + 4 * 3_600_000), CITY.bengaluru.tz)

    curatedIds[c.slug] = ev.id
  }

  /*
   * Refusals on the dead one. No coordinates are stored -- only the shortfall,
   * which is what tells a wrong pin from a fence that is merely tight.
   */
  const deadId = curatedIds["seeded-curated-dead"]
  if (deadId) {
    for (let i = 0; i < 5; i++) {
      const userId = attendeeIds[i % attendeeIds.length]
      const existing = await db.check_in_refusals.findFirst({
        where: { event_id: deadId, user_id: userId, reason: "out_of_range" },
      })
      if (!existing) {
        await db.check_in_refusals.create({
          data: {
            event_id: deadId,
            user_id: userId,
            reason: "out_of_range",
            shortfall_metres: 90 + i * 25,
            accuracy_metres: 15,
          },
        })
      }
    }
  }

  // ── the four queues, in every state ──────────────────────────────────────
  const openId = curatedIds["seeded-curated-open"]
  const claimedId = curatedIds["seeded-curated-claimed"]

  const eventClaimSpecs = [
    { eventId: openId, email: "events@toit.in", status: "pending" as const,
      flags: ["domain_matches_source"], note: "We run this every Sunday." },
    { eventId: openId, email: "bookings@in.bookmyshow.com", status: "pending" as const,
      flags: ["source_is_aggregator", "no_organisation_yet"], note: "Listing is ours." },
    { eventId: claimedId, email: "hello@permitroom.in", status: "approved" as const,
      flags: [], note: "Approved — this is what a handed-over event looks like." },
    { eventId: claimedId, email: "someone@else.com", status: "superseded" as const,
      flags: ["no_organisation_yet"], note: "Lost the race. Superseded, not declined." },
    { eventId: openId, email: "chancer@gmail.com", status: "declined" as const,
      flags: ["free_email_provider"], note: "Declined, with a reason." },
  ]
  for (const spec of eventClaimSpecs) {
    if (!spec.eventId) continue
    const existing = await db.event_claims.findFirst({
      where: { event_id: spec.eventId, contact_email: spec.email },
    })
    if (existing) continue
    /*
     * Exactly one claimant, because the database insists.
     *
     * `event_claims_one_claimant` is
     * `CHECK ((org_id IS NULL) <> (onboarding_id IS NULL))` -- a claim comes
     * either from an organisation that already exists, or from an onboarding
     * request filed by somebody with no account. Never both, and never
     * neither.
     *
     * This seed used to set `org_id` on the approved claim and leave *both*
     * columns null on the other four, which the constraint rejects. It never
     * failed locally because `prisma db push` does not create CHECK
     * constraints at all -- `schema.prisma` cannot express them, so they exist
     * only in migration SQL. Three of them were missing from every
     * `db push` database in this project, including the one this seed had
     * always been tested against. CI caught it the moment that lane switched
     * to `migrate deploy`.
     *
     * The fix mirrors the real funnel rather than working around the check:
     * `/claim/[eventId]` sends a claimant with no account through
     * `POST /api/onboarding/apply` first, then files the claim against the
     * request that returns. So the seed does the same.
     */
    let onboardingId: string | null = null
    if (spec.status !== "approved") {
      const existingRequest = await db.organiser_onboarding_requests.findFirst({
        where: { contact_email: spec.email },
        select: { id: true },
      })
      onboardingId =
        existingRequest?.id ??
        (
          await db.organiser_onboarding_requests.create({
            data: {
              kind: "company",
              display_name: spec.email.split("@")[1] ?? spec.email,
              legal_name: `${spec.email.split("@")[1] ?? spec.email} Pvt Ltd`,
              city: CITY.bengaluru.name,
              contact_name: "Seeded Claimant",
              contact_email: spec.email,
              requested_role: "organizer",
              // A free provider or an aggregator address is exactly the
              // needs_proof path — the tier the real gate assigns when the
              // domain proves nothing on its own.
              tier: "needs_proof",
              status: "pending",
            },
            select: { id: true },
          })
        ).id
    }

    await db.event_claims.create({
      data: {
        event_id: spec.eventId,
        contact_email: spec.email,
        note: spec.note,
        status: spec.status,
        flags: spec.flags,
        org_id: spec.status === "approved" ? orgs.events.id : null,
        onboarding_id: onboardingId,
        reviewed_by: spec.status === "pending" ? null : users.sagar,
        reviewed_at: spec.status === "pending" ? null : hoursFromNow(-20),
        decision_note: spec.status === "declined" ? "Personal address, no proof of connection." : null,
      },
    })
  }

  // Venue claim on the unclaimed venue, pending.
  const existingVenueClaim = await db.venue_claims.findFirst({
    where: { venue_id: unclaimed.id, org_id: orgs.venues.id },
  })
  if (!existingVenueClaim) {
    await db.venue_claims.create({
      data: { venue_id: unclaimed.id, org_id: orgs.venues.id, filed_by: users.venue, status: "pending" },
    })
  }

  // ── sponsors and a brand claim ───────────────────────────────────────────
  const brandName = "Blue Tokai"
  let sponsor = await db.sponsors.findFirst({ where: { name_key: brandName.toLowerCase() } })
  if (!sponsor) {
    sponsor = await db.sponsors.create({
      data: {
        name: brandName,
        name_key: brandName.toLowerCase(),
        org_id: orgs.brands.id,
        claimed_at: hoursFromNow(-300),
        created_by: users.sagar,
      },
    })
  }
  // An unclaimed brand, so the claim queue has a target.
  let unclaimedBrand = await db.sponsors.findFirst({ where: { name_key: "third wave" } })
  if (!unclaimedBrand) {
    unclaimedBrand = await db.sponsors.create({
      data: { name: "Third Wave", name_key: "third wave", org_id: null, created_by: users.sagar },
    })
  }
  const existingBrandClaim = await db.sponsor_claims.findFirst({
    where: { sponsor_id: unclaimedBrand.id, org_id: orgs.brands.id },
  })
  if (!existingBrandClaim) {
    await db.sponsor_claims.create({
      data: {
        sponsor_id: unclaimedBrand.id,
        org_id: orgs.brands.id,
        filed_by: users.sponsor,
        status: "pending",
      },
    })
  }

  // ── onboarding applications, both paths and every state ──────────────────
  /*
   * The automatic path and the manual one, side by side. A company-domain
   * address passes `canSubmitApplication` freely; a free provider must carry a
   * valid GSTIN or a website, and the queue is where a human reads the
   * difference.
   */
  const APPLICATIONS = [
    { email: "founder@thehummingtree.com", display: "The Humming Tree", contact: "Priya Rao",
      status: "pending" as const, tier: "domain" as const, website: null,
      why: "Automatic path — company domain, passes the gate with nothing else." },
    { email: "nights@gmail.com", display: "Basement Six", contact: "Dev Kumar",
      status: "pending" as const, tier: "needs_proof" as const, website: "https://basementsix.in",
      why: "Manual path — free provider, carried a website instead." },
    { email: "unverified@toit.in", display: "Toit Brewpub", contact: "Anita Shah",
      status: "email_pending" as const, tier: "domain" as const, website: null,
      why: "Sent a confirmation link and is waiting on it. Never reaches a reviewer." },
    { email: "approved@permitroom.in", display: "The Permit Room", contact: "Rahul Nayak",
      status: "approved" as const, tier: "domain" as const, website: null,
      why: "Approved. An org, a user and a membership should exist for it." },
    { email: "spam@gmail.com", display: "Definitely Real Events", contact: "A Person",
      status: "declined" as const, tier: "needs_proof" as const, website: null,
      why: "Declined, with a reason the applicant receives." },
  ]
  for (const a of APPLICATIONS) {
    const existing = await db.organiser_onboarding_requests.findFirst({
      where: { contact_email: a.email },
    })
    if (existing) continue
    await db.organiser_onboarding_requests.create({
      data: {
        kind: "company",
        display_name: a.display,
        legal_name: `${a.display} Pvt Ltd`,
        website: a.website,
        city: CITY.bengaluru.name,
        contact_name: a.contact,
        contact_email: a.email,
        requested_role: "organizer",
        tier: a.tier,
        status: a.status,
        email_verified_at: a.status === "email_pending" ? null : hoursFromNow(-50),
        reviewed_by: a.status === "approved" || a.status === "declined" ? users.sagar : null,
        reviewed_at: a.status === "approved" || a.status === "declined" ? hoursFromNow(-30) : null,
        decline_reason: a.status === "declined" ? "No verifiable connection to the events listed." : null,
      },
    })
  }

  /*
   * ── the notification centre, which had no rows at all ───────────────────
   *
   * `notifications` is the bell in the Pulse's top bar and the permanent copy
   * that outlives every push — the row that sits outside all the controls
   * guarding `private_messages`, and the reason `storedBodyFor` redacts
   * content-bearing kinds at all.
   *
   * The seed never wrote one. `e2e/pseudonymity.spec.ts` asserts that no
   * stored notification carries a real name, and that passed locally only
   * because messages posted by hand during testing had left rows behind. On a
   * fresh database there were zero, and its own vacuity guard refused:
   * "the seed must have notifications, or this is vacuous". It was right — the
   * property was being asserted over an empty set.
   *
   * Bodies go through `storedBodyFor`, exactly as the push path does, so the
   * seeded world shows what the product actually stores rather than a
   * hand-written approximation of it. A `group_message` therefore reads "New
   * message in the room" here, and the pseudonymous check-in line keeps its
   * pseudonym — which is the distinction the spec exists to police.
   */
  const notificationSpecs = [
    { kind: "group_message" as const, title: "New message",
      body: "hey, is anyone near the bar?" },
    { kind: "private_message" as const, title: "New message",
      body: "loved chatting earlier — same time next week?" },
    { kind: "event_checkin" as const, title: "Someone just arrived",
      body: "Cosmic Panda just checked in!" },
    { kind: "match" as const, title: "It's a match",
      body: "You and someone in the room both said yes." },
    { kind: "announcement" as const, title: "From the organiser",
      body: "Last orders in twenty minutes." },
  ]
  let notificationsMade = 0
  for (const [i, spec] of notificationSpecs.entries()) {
    const userId = attendeeIds[i % attendeeIds.length]
    const existing = await db.notifications.findFirst({
      where: { user_id: userId, kind: spec.kind, title: spec.title },
      select: { id: true },
    })
    if (existing) continue
    await db.notifications.create({
      data: {
        user_id: userId,
        kind: spec.kind,
        title: spec.title,
        // Through the product's own redaction, not around it.
        body: storedBodyFor(spec.kind, spec.body),
        read_at: i % 2 === 0 ? null : hoursFromNow(-3),
      },
    })
    notificationsMade++
  }

  // ── demand, so the Cities table has a row with no supply ─────────────────
  /*
   * Pune deliberately has demand and no events. `city_demand` is written on
   * every miss and read by nothing today — and the admin Cities table is built
   * by iterating events, so a city with demand and zero events cannot appear in
   * it at all (C12). This row is what makes that visible.
   */
  for (const [i, userId] of attendeeIds.entries()) {
    const city = i < 4 ? "Pune" : "Hyderabad"
    const existing = await db.city_demand.findFirst({ where: { user_id: userId, city_key: city.toLowerCase() } })
    if (existing) continue
    await db.city_demand.create({
      data: { user_id: userId, city, city_key: city.toLowerCase(), country: "India", opens: 3 + i },
    })
  }

  // ── retire the previous names ────────────────────────────────────────────
  if (APPLY) {
    const retired = await db.events.updateMany({
      where: { slug: { in: RETIRED_SLUGS }, deleted_at: null },
      data: { deleted_at: new Date() },
    })
    if (retired.count > 0) console.log(`Retired ${retired.count} event(s) under old QA names.`)
  }

  /* ---------------------------------------------------------------------- */

  console.log(`\n${"=".repeat(78)}`)
  console.log("PASTE INTO THE JIRA ENVIRONMENT TICKET")
  console.log(`${"=".repeat(78)}\n`)
  /*
   * Staging hosts, spelled out.
   *
   * The production pair is `dashboard.blendn.app` / `api.blendn.app` — the same
   * names without the prefix, which is one missing word away from pointing a
   * whole QA team at production. That already happened once, from this script's
   * output being pasted into a ticket.
   *
   * Not read from `DASHBOARD_HOST`: this runs with only `DATABASE_URL` set, so
   * the env lookup would resolve to nothing and print a blank line, which is a
   * worse failure than a wrong URL because nobody notices it.
   */
  console.log(`Dashboard: https://staging-dashboard.blendn.app`)
  console.log(`API:       https://staging-api.blendn.app`)
  console.log(`\n  NOT dashboard.blendn.app / api.blendn.app — those are production.\n`)
  for (const c of created) {
    console.log(`${c.role}`)
    console.log(`  email     ${c.email}`)
    console.log(`  password  ${c.password}`)
    console.log(`  org       ${c.org}`)
    console.log(`  ${c.note}\n`)
  }
  console.log("Passwords are shown once and are not recoverable. Re-run to reset.")
  console.log(`\nVenues: ${circle.name} (circle), ${polygon.name} (polygon), ${unclaimed.name} (unclaimed)`)
  console.log(`Events: ${EVENTS.length} across ${Object.keys(CITY).length} cities`)
  console.log(`\nAttendees (mobile only, same password): ${ATTENDEES.map((a) => a.email).join(", ")}`)
  console.log(`  ${ATTENDEES.find((a) => a.age < 18)?.email} is under 18 — the age gate has something to refuse.`)
  /*
   * Counted from the database, not from what this run happened to insert.
   *
   * The first version printed the number of rows CREATED, so a second run --
   * which is the normal case, because the script is idempotent -- reported
   * zeros across the board and read as an empty world. A summary that says
   * nothing exists when everything does is worse than no summary.
   */
  const [
    rsvpTotal, checkInTotal, msgTotal, refusalTotal, claimTotal, appTotal, demandTotal,
  ] = await Promise.all([
    db.event_rsvps.count(),
    db.event_check_ins.count(),
    db.chat_messages.count(),
    db.check_in_refusals.count(),
    db.event_claims.count(),
    db.organiser_onboarding_requests.count(),
    db.city_demand.count(),
  ])

  console.log(`\nWorld (present, not merely created by this run):`)
  console.log(`  rsvps            ${rsvpTotal} — more than the check-ins, so no-show is a real number`)
  console.log(`  check-ins        ${checkInTotal} (one person is in two events — the only true repeat)`)
  console.log(`  chat             ${msgTotal} messages, one carries a phone number for the contact-info filter`)
  console.log(`  curated events   ${CURATED.length} (open / dead / claimed), ${refusalTotal} refusals on the dead one`)
  console.log(`  event claims     ${claimTotal} across pending, approved, declined, superseded`)
  console.log(`  applications     ${appTotal} across pending, email_pending, approved, declined`)
  console.log(`  demand           ${demandTotal} rows — Pune has demand and no events`)
  console.log(`  brands           Blue Tokai (claimed), Third Wave (unclaimed, claim pending)\n`)
}

async function upsertOrg(displayName: string) {
  const existing = await db.organisations.findFirst({ where: { display_name: displayName } })
  if (existing) {
    return db.organisations.update({
      where: { id: existing.id },
      data: { status: "verified", verified_at: new Date() },
    })
  }
  return db.organisations.create({
    data: {
      display_name: displayName,
      kind: "company",
      status: "verified",
      verified_at: new Date(),
    },
  })
}

async function upsertVenue(input: {
  slugName: string
  city: string
  lat: number
  lng: number
  ownerOrgId: string | null
  ownerId: string | null
  geofence: unknown
}) {
  const existing = await db.venues.findFirst({ where: { name: input.slugName } })
  const data = {
    name: input.slugName,
    city: input.city,
    address: `${input.slugName}, ${input.city}`,
    latitude: input.lat,
    longitude: input.lng,
    owner_org_id: input.ownerOrgId,
    owner_id: input.ownerId,
    claimed_at: input.ownerOrgId ? new Date() : null,
    geofence: (input.geofence ?? undefined) as never,
    venue_type: "banquet_hall" as never,
    capacity: 300,
    deleted_at: null,
  }
  return existing
    ? db.venues.update({ where: { id: existing.id }, data })
    : db.venues.create({ data })
}

main()
  .catch((error) => {
    console.error("FAILED:", error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
