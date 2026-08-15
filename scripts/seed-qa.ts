import { randomBytes } from "node:crypto"

import { PrismaClient, type user_role } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"

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

/** Same generator and cost as `create-dashboard-user.ts`, deliberately. */
const generatePassword = () => randomBytes(18).toString("base64url")
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
 * `picsum.photos` seeded by name — stable across runs, so a screenshot diff
 * stays meaningful, and square at 2048 so it is the master shape organisers are
 * asked for rather than a shape that happens to fit one slot.
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

const cover = (seed: string) => `https://picsum.photos/seed/blendn-${seed}/2048/2048`

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
    console.log(`  2 organisations, ${ACCOUNTS.length} accounts, 3 venues, ${EVENTS.length} events`)
    for (const a of ACCOUNTS) console.log(`    ${a.role.padEnd(12)} ${a.email}`)
    for (const e of EVENTS) console.log(`    ${e.slug.padEnd(22)} ${e.why}`)
    console.log("\nRe-run with --apply to write.\n")
    return
  }

  // ── organisations ────────────────────────────────────────────────────────
  const orgs = {
    events: await upsertOrg("Nightshift Collective"),
    venues: await upsertOrg("Indiranagar Hospitality Group"),
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
        cover_image_url: spec.media ? cover(spec.media) : null,
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
      const data = {
        event_id: event.id,
        type: "video" as const,
        url: clip,
        thumbnail_url: cover(spec.media),
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
  console.log(`Events: ${EVENTS.length} across ${Object.keys(CITY).length} cities\n`)
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
