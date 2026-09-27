/**
 * Gives one real account a believable history, so the Me tab can be judged
 * with data in it: Nights out dots, the Recent rail, rolling stats, a bio.
 *
 *   railway run --environment staging -- npx tsx scripts/seed-me-demo.ts            # dry run
 *   railway run --environment staging -- npx tsx scripts/seed-me-demo.ts --apply    # write
 *   railway run --environment staging -- npx tsx scripts/seed-me-demo.ts --undo     # remove the events again
 *
 *   SEED_ME_EMAIL=someone@example.com ... to target another account.
 *
 * ## What it writes
 *
 * - **Profile**: bio, occupation and location (from the owner's GitHub
 *   README). Photos, name and everything else are left alone.
 * - **Interests**: replaced with the leaf categories in `INTERESTS` that exist.
 * - **Past events**: twelve ended, *unlisted* events over the last twelve
 *   weeks, each with occurrences (`event_check_ins.occurrence_id` is NOT NULL),
 *   and a `checked_out` attendee check-in for this account on each. Two share
 *   a night, so the grid's "+1 more" line shows. Unlisted keeps them out of
 *   discovery; they are ended anyway.
 *
 * ## Safe to re-run
 *
 * Events are keyed by slug (`me-demo-<user>-<n>`) and upserted; check-ins are
 * upserted on `(occurrence_id, user_id)`. Dates are recomputed from today on
 * every run, so re-running later slides the history forward rather than
 * letting it age out of the twelve-week window. `--undo` deletes the events,
 * which cascades to their occurrences and check-ins.
 *
 * Dry run by default: it prints the database host, the account it found and
 * what it would do, and writes nothing without `--apply`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { syncOccurrences } from "../lib/occurrences"

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

const EMAIL = (process.env.SEED_ME_EMAIL ?? "hemanth@unbothered.studio").trim().toLowerCase()
const APPLY = process.argv.includes("--apply")
const UNDO = process.argv.includes("--undo")

const PROFILE = {
  bio:
    "AI engineer building LLM-powered products, with a frontend craftsman's eye. " +
    "Co-founder of Unbothered Studio (Awwwards, CSS Design Awards). Shipped Comet Currency " +
    "and Blend'n. Always up for talking agents, React Native and good design.",
  occupation: "AI Engineer at Redica Systems",
  location: "Bengaluru",
}

/** Leaf category names from `scripts/seed-categories.ts`. Missing ones are skipped and reported. */
const INTERESTS = [
  "Meetups",
  "Hackathons",
  "Talks",
  "Demo days",
  "Founders",
  "Product launches",
  "Conferences",
  "Exhibitions",
  "Film screenings",
  "Art fairs",
  "Live gigs",
  "Comedy",
  "Coffee",
  "Supper clubs",
]

const CITY = { name: "Bengaluru", state: "Karnataka", country: "India", timezone: "Asia/Kolkata" }

/*
 * Covers from `scripts/seed-blr-photos.json`: Unsplash ids already checked by
 * the Bengaluru reseed. Hotlinked, not mirrored to Tigris: this is staging data.
 */
const PHOTOS = JSON.parse(
  readFileSync(join(__dirname, "seed-blr-photos.json"), "utf8")
) as Record<string, { id: string; alt: string }[]>
const photo = (subject: string, i = 0): string | null => {
  const list = PHOTOS[subject]
  const id = list?.[i % list.length]?.id
  return id ? `https://images.unsplash.com/${id}?w=1200&h=1500&fit=crop&q=80&fm=jpg` : null
}

/*
 * The history. `daysAgo` is the evening it happened; `hour` is the local
 * start (IST). Day 12 has two events on one night, so the grid shows "+1 more".
 */
const HISTORY: {
  daysAgo: number
  hour: number
  hours: number
  title: string
  venue: string
  lat: number
  lng: number
  cover: string | null
}[] = [
  { daysAgo: 2, hour: 19, hours: 3, title: "Bangalore AI Builders: Agents in Production", venue: "91springboard Koramangala", lat: 12.9352, lng: 77.6245, cover: photo("tech-meetup", 0) },
  { daysAgo: 5, hour: 20, hours: 3, title: "Stand-up Night at The Humming Tree", venue: "The Humming Tree", lat: 12.9784, lng: 77.6408, cover: photo("comedy", 0) },
  { daysAgo: 9, hour: 8, hours: 2, title: "Founders Breakfast: Shipping Consumer Apps", venue: "Third Wave Coffee, Indiranagar", lat: 12.9719, lng: 77.6412, cover: photo("founders-breakfast", 0) },
  { daysAgo: 12, hour: 17, hours: 3, title: "Design Systems Meetup: Motion Tokens", venue: "Atlassian Bengaluru", lat: 12.9279, lng: 77.6271, cover: photo("design-festival", 0) },
  { daysAgo: 12, hour: 21, hours: 3, title: "Rooftop DJ Set: Deep House Sundowner", venue: "High Ultra Lounge", lat: 13.0106, lng: 77.5552, cover: null },
  { daysAgo: 19, hour: 19, hours: 3, title: "Open-Air Film: In the Mood for Love", venue: "Bangalore International Centre", lat: 12.9606, lng: 77.6414, cover: photo("open-air-film", 0) },
  { daysAgo: 26, hour: 10, hours: 8, title: "Hack Night: Build with MCP", venue: "NSRCEL, IIM Bangalore", lat: 12.8943, lng: 77.6011, cover: photo("hackathon", 0) },
  { daysAgo: 33, hour: 18, hours: 3, title: "Bengaluru Design Festival: Opening Night", venue: "Bangalore Palace Grounds", lat: 12.9987, lng: 77.5921, cover: photo("design-festival", 1) },
  { daysAgo: 41, hour: 20, hours: 3, title: "Supper Club: Coastal Karnataka Tasting", venue: "Toast & Tonic", lat: 12.9716, lng: 77.6412, cover: photo("supper-club", 0) },
  { daysAgo: 54, hour: 18, hours: 4, title: "Product Demo Day: Summer Cohort", venue: "WeWork Galaxy", lat: 12.9716, lng: 77.6089, cover: null },
  { daysAgo: 62, hour: 19, hours: 3, title: "Live Gig: Indie Night at BFlat", venue: "BFlat Bar", lat: 12.9784, lng: 77.6387, cover: photo("rooftop-dj", 0) },
  { daysAgo: 76, hour: 11, hours: 5, title: "Art Fair: Contemporary Printmakers", venue: "Chitrakala Parishath", lat: 12.9912, lng: 77.5816, cover: photo("art-workshop", 0) },
]

/** A local IST wall-clock time `daysAgo` days before today, as a UTC instant. */
function istAt(daysAgo: number, hour: number): Date {
  const IST_MS = 5.5 * 60 * 60 * 1000
  const nowIst = new Date(Date.now() + IST_MS)
  const d = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate() - daysAgo, hour, 0)
  return new Date(d - IST_MS)
}

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host
    } catch {
      return "(unset)"
    }
  })()
  console.log(`database  ${host}`)
  console.log(`mode      ${UNDO ? "UNDO" : APPLY ? "APPLY" : "dry run (pass --apply to write)"}`)

  const user = await db.user.findUnique({ where: { email: EMAIL }, include: { profile: true } })
  if (!user) {
    console.error(`No user with email ${EMAIL} in this database.`)
    process.exit(1)
  }
  console.log(`account   ${user.email} (${user.id}), profile: ${user.profile ? "yes" : "MISSING"}`)
  if (!user.profile) {
    console.error("The account has no profile row; finish onboarding in the app first.")
    process.exit(1)
  }

  const slugBase = `me-demo-${user.id.slice(-8).toLowerCase()}`

  if (UNDO) {
    const existing = await db.events.findMany({ where: { slug: { startsWith: slugBase } }, select: { id: true, title: true } })
    console.log(`would delete ${existing.length} demo event(s)`)
    if (APPLY || process.argv.includes("--yes")) {
      const { count } = await db.events.deleteMany({ where: { slug: { startsWith: slugBase } } })
      console.log(`deleted ${count} event(s), with their occurrences and check-ins`)
    } else {
      console.log("pass --undo --yes to delete")
    }
    return
  }

  // The organiser can't be this account: an attendee owning events would also show "Hosted".
  const organizer = await db.user.findFirst({
    where: { role: { not: "attendee" }, id: { not: user.id }, deletedAt: null },
    orderBy: { createdAt: "asc" },
  })
  if (!organizer) {
    console.error("No non-attendee user to own the demo events. Run seed:accounts first.")
    process.exit(1)
  }
  console.log(`organiser ${organizer.email}`)

  const leaves = await db.categories.findMany({
    where: { name: { in: INTERESTS }, parent_id: { not: null } },
    select: { id: true, name: true },
  })
  const found = new Set(leaves.map((l) => l.name))
  const missing = INTERESTS.filter((n) => !found.has(n))
  console.log(`interests ${leaves.length} matched${missing.length ? `, skipped: ${missing.join(", ")}` : ""}`)

  const plan = HISTORY.map((h, i) => {
    const start = istAt(h.daysAgo, h.hour)
    return { ...h, slug: `${slugBase}-${i + 1}`, start, end: new Date(start.getTime() + h.hours * 3600_000) }
  })
  for (const p of plan) console.log(`  ${p.start.toISOString().slice(0, 16)}Z  ${p.title}`)

  if (!APPLY) {
    console.log("\nDry run: nothing written.")
    return
  }

  await db.profiles.update({
    where: { id: user.id },
    data: { ...PROFILE, updated_at: new Date() },
  })

  await db.user_interests.deleteMany({ where: { user_id: user.id } })
  await db.user_interests.createMany({
    data: leaves.map((c) => ({ user_id: user.id, category_id: c.id })),
    skipDuplicates: true,
  })

  for (const p of plan) {
    const data = {
      title: p.title,
      description: `${p.title}. A night out in ${CITY.name}, seeded so the Me tab has history to show.`,
      short_description: p.venue,
      latitude: p.lat,
      longitude: p.lng,
      address: `${p.venue}, ${CITY.name}`,
      venue_name: p.venue,
      city: CITY.name,
      state: CITY.state,
      country: CITY.country,
      start_time: p.start,
      end_time: p.end,
      timezone: CITY.timezone,
      status: "published" as const,
      visibility: "unlisted" as const,
      organizer_id: organizer.id,
      cover_image_url: p.cover,
      check_in_radius: 150,
    }
    const event = await db.events.upsert({ where: { slug: p.slug }, create: { slug: p.slug, ...data }, update: data })

    // Dates move on every run. Through the one mechanism every event write
    // uses (__tests__/events-have-occurrences.test.ts): days that fall away are
    // removed with their check-ins, a day that stays keeps its id.
    await syncOccurrences(event.id, event.start_time, event.end_time, event.timezone)
    const occurrence = await db.event_occurrences.findFirstOrThrow({
      where: { event_id: event.id },
      orderBy: { start_time: "asc" },
    })

    const checkIn = new Date(p.start.getTime() + 20 * 60_000)
    const checkOut = new Date(p.end.getTime() - 15 * 60_000)
    await db.event_check_ins.upsert({
      where: { occurrence_id_user_id: { occurrence_id: occurrence.id, user_id: user.id } },
      create: {
        event_id: event.id,
        occurrence_id: occurrence.id,
        user_id: user.id,
        kind: "attendee",
        status: "checked_out",
        check_in_time: checkIn,
        check_out_time: checkOut,
        latitude: p.lat,
        longitude: p.lng,
      },
      update: { status: "checked_out", check_in_time: checkIn, check_out_time: checkOut },
    })
  }

  console.log(`\nDone: profile updated, ${leaves.length} interests, ${plan.length} attended events.`)
  console.log("Pull to refresh on the Me tab to see it.")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
