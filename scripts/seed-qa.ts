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
 *     Blendn QA Events   ← organiser is a member.   Runs the events.
 *     Blendn QA Venues   ← venue owner is a member. Owns the buildings.
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
    email: "qa-admin@blendn.app",
    name: "QA Admin",
    role: "app_admin" as user_role,
    org: null,
    note: "Sees everything. eventPermissions short-circuits before org checks.",
  },
  {
    key: "organiser",
    email: "qa-organiser@blendn.app",
    name: "QA Organiser",
    role: "organizer" as user_role,
    org: "events" as const,
    note: "Member of the org that RUNS the events. May edit and operate them.",
  },
  {
    key: "venue",
    email: "qa-venue@blendn.app",
    name: "QA Venue Owner",
    role: "venue_owner" as user_role,
    org: "venues" as const,
    note: "Member of the org that OWNS the buildings. May operate, must NOT edit.",
  },
  {
    key: "outsider",
    email: "qa-outsider@blendn.app",
    name: "QA Outsider",
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
  { slug: "qa-baseline-blr", title: "QA Baseline — Bengaluru", city: "bengaluru", venue: "circle",
    startsIn: 48, hours: 3, status: "published", visibility: "public", cover: true, minAge: null,
    category: null, why: "The everything-works case. Circle geofence, cover image, future." },
  { slug: "qa-polygon-stadium", title: "QA Stadium — polygon fence", city: "bengaluru", venue: "polygon",
    startsIn: 72, hours: 4, status: "published", visibility: "public", cover: true, minAge: null,
    category: null, why: "Polygon check-in, and the shortfall message for a non-circular venue." },
  { slug: "qa-age-gated", title: "QA 18+ Night", city: "bengaluru", venue: "circle",
    startsIn: 96, hours: 5, status: "published", visibility: "public", cover: true, minAge: 18,
    category: "nightlife-parties", why: "Age gating. Must be hidden from an under-18 profile." },
  { slug: "qa-nightlife", title: "QA DJ Set", city: "bengaluru", venue: "circle",
    startsIn: 120, hours: 4, status: "published", visibility: "public", cover: true, minAge: null,
    category: "nightlife-dj-sets", why: "The Nightlife section, which groups on the PARENT slug." },
  { slug: "qa-classical", title: "QA Classical Recital", city: "bengaluru", venue: "circle",
    startsIn: 130, hours: 2, status: "published", visibility: "public", cover: true, minAge: null,
    category: "music-classical-and-carnatic",
    why: "Must NOT appear under Nightlife. The old substring match filed it as a party." },
  { slug: "qa-no-cover", title: "QA Event Without A Cover Image", city: "bengaluru", venue: "circle",
    startsIn: 60, hours: 2, status: "published", visibility: "public", cover: false, minAge: null,
    category: null, why: "The coverless card. Used to render as an empty grey rectangle." },
  { slug: "qa-live-now", title: "QA Happening Now", city: "bengaluru", venue: "circle",
    startsIn: -0.5, hours: 3, status: "published", visibility: "public", cover: true, minAge: null,
    category: null, why: "Check-in is only possible while an event is on." },
  { slug: "qa-ended", title: "QA Finished Last Week", city: "bengaluru", venue: "circle",
    startsIn: -200, hours: 3, status: "published", visibility: "public", cover: true, minAge: null,
    category: null, why: "Must NOT appear in discovery. Only with includePast." },
  { slug: "qa-draft", title: "QA Draft — should be invisible", city: "bengaluru", venue: "circle",
    startsIn: 80, hours: 2, status: "draft", visibility: "public", cover: true, minAge: null,
    category: null, why: "NEGATIVE. A draft reaching an attendee is a leak, not a display bug." },
  { slug: "qa-private", title: "QA Private — should be invisible", city: "bengaluru", venue: "circle",
    startsIn: 85, hours: 2, status: "published", visibility: "private", cover: true, minAge: null,
    category: null, why: "NEGATIVE. Same class as the draft." },
  { slug: "qa-mumbai", title: "QA Mumbai Meetup", city: "mumbai", venue: null,
    startsIn: 50, hours: 3, status: "published", visibility: "public", cover: true, minAge: null,
    category: null, why: "A second city. Without one, the picker cannot be tested at all." },
  { slug: "qa-saarbruecken", title: "QA Saarbrücken Social", city: "saarbruecken", venue: null,
    startsIn: 55, hours: 3, status: "published", visibility: "public", cover: true, minAge: null,
    category: null,
    why: "Makes the switch banner and the resume policy testable from a device in Germany." },
] as const

const COVER = "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1200"

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
    events: await upsertOrg("Blendn QA Events"),
    venues: await upsertOrg("Blendn QA Venues"),
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
    slugName: "QA Circle Venue",
    city: blr.name,
    lat: blr.lat,
    lng: blr.lng,
    ownerOrgId: orgs.venues.id,
    ownerId: users.venue,
    geofence: { type: "circle", lat: blr.lat, lng: blr.lng, radius: 40, buffer: 20 },
  })
  const polygon = await upsertVenue({
    slugName: "QA Stadium",
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
    slugName: "QA Unclaimed Venue",
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
        cover_image_url: spec.cover ? COVER : null,
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

  /* ---------------------------------------------------------------------- */

  console.log(`\n${"=".repeat(78)}`)
  console.log("PASTE INTO THE JIRA ENVIRONMENT TICKET")
  console.log(`${"=".repeat(78)}\n`)
  console.log(`Dashboard: https://dashboard.blendn.app   (staging)`)
  console.log(`API:       https://staging-api.blendn.app\n`)
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
