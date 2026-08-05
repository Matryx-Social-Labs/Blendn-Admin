/**
 * Seed the two-level category taxonomy.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-categories.ts
 *
 * Idempotent — upserts on slug, so it is safe to re-run and safe against an
 * environment that already has the eight flat categories production started
 * with. Those eight are kept as parents rather than replaced, so every event
 * already tagged to them keeps its tag.
 *
 * Deliberately two levels deep. `app/api/mobile/events/route.ts` filters a
 * parent by matching the category or its direct children; a third level would
 * be silently missed, so the tree stays flat at two and the filter stays a
 * single query.
 *
 * Screenings live under Sports and Arts & Culture rather than becoming a new
 * kind of event: an IPL screening is a place you go to watch with people, so
 * GPS check-in, capacity, the chatroom and the feedback window all apply
 * unchanged.
 */
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

/**
 * Must match the slugs production already uses, or an upsert-on-slug creates a
 * *duplicate* parent instead of adopting the existing one — leaving the real
 * category orphaned with its events still attached to it.
 *
 * Production has `arts-culture` and `food-drink`, so `&` is dropped rather than
 * expanded to "and". The first version of this script expanded it, created two
 * phantom parents, and only the orphan check at the end caught it.
 */
const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")

/** Parent -> children. Parents match the names production already uses. */
const TAXONOMY: Record<string, string[]> = {
  Music: ["Live gigs", "Club nights", "Tours", "Open mic", "Festivals"],
  Sports: [
    // The India-specific ones the product wants to surface.
    "IPL screening",
    "Cricket screening",
    "Football screening",
    "F1 screening",
    "Running",
    "Play and train",
  ],
  "Food & Drink": ["Tastings", "Supper clubs", "Brunch", "Pop-ups", "Food festivals"],
  Nightlife: ["Parties", "DJ sets", "Comedy", "Karaoke"],
  "Arts & Culture": ["Theatre", "Exhibitions", "Film screenings", "Workshops", "Literature"],
  Tech: ["Meetups", "Hackathons", "Talks", "Demo days"],
  Networking: ["Professional", "Founders", "Industry mixers", "Career"],
  Outdoor: ["Hikes", "Cycling", "Adventure", "Camping"],
  Wellness: ["Yoga", "Fitness", "Meditation", "Mental health"],
  Community: ["Volunteering", "Language exchange", "Hobby groups", "Family"],
}

async function main() {
  let parents = 0
  let children = 0

  for (const [parentName, childNames] of Object.entries(TAXONOMY)) {
    const parent = await db.categories.upsert({
      where: { slug: slugify(parentName) },
      update: { name: parentName },
      create: { name: parentName, slug: slugify(parentName) },
    })
    parents += 1

    for (const childName of childNames) {
      // Child slugs are namespaced by parent: "Cricket screening" under Sports
      // and a future "Cricket" under Community would otherwise collide on a
      // unique slug and the second upsert would silently reparent the first.
      const slug = `${slugify(parentName)}-${slugify(childName)}`
      await db.categories.upsert({
        where: { slug },
        update: { name: childName, parent_id: parent.id },
        create: { name: childName, slug, parent_id: parent.id },
      })
      children += 1
    }
  }

  const orphans = await db.categories.count({
    where: { parent_id: null, NOT: { slug: { in: Object.keys(TAXONOMY).map(slugify) } } },
  })

  console.log(`parents: ${parents}  children: ${children}`)
  if (orphans > 0) {
    // Not deleted: an existing category may already have events tagged to it,
    // and removing it would strip those tags. Flagged for a human instead.
    console.log(`\n${orphans} top-level categor${orphans === 1 ? "y" : "ies"} not in the taxonomy.`)
    const rows = await db.categories.findMany({
      where: { parent_id: null, NOT: { slug: { in: Object.keys(TAXONOMY).map(slugify) } } },
      select: { name: true, slug: true, _count: { select: { events: true } } },
    })
    for (const r of rows) console.log(`  ${r.name} (${r.slug}) — ${r._count.events} events`)
    console.log("Left alone; re-tag their events before removing any.")
  }
}

main()
  .catch((error) => {
    console.error("FAILED:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
  .finally(() => db.$disconnect())
