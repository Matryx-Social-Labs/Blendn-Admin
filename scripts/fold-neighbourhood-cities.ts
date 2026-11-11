import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { buildCatalogue, cityToStore } from "../lib/cities"
import { realEventsWhere } from "../lib/event-kind"
import { environmentRefusal } from "./test-accounts"

/**
 * SCRUM-1038, the rows written before the fix: an event whose city is a name the catalogue does not know, at a pin
 * inside a catalogue city, is stored as that city — the rule every event write now applies (`cityToStore`).
 * "Koramangala" at a Bengaluru pin becomes "Bengaluru"; "Saarbrücken" at its own pin stays.
 *
 * Staging or a local database only (`environmentRefusal`). Dry run unless `--apply`; idempotent.
 *
 *   DATABASE_URL=... RAILWAY_ENVIRONMENT_NAME=staging npx tsx scripts/fold-neighbourhood-cities.ts [--apply]
 */
const APPLY = process.argv.includes("--apply")

async function main() {
  const refusal = environmentRefusal(process.env)
  if (refusal) {
    console.error(`REFUSING: ${refusal}`)
    process.exitCode = 1
    return
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  try {
    const catalogue = buildCatalogue(await db.markets.findMany(), await db.cities.findMany())
    const events = await db.events.findMany({
      // A venue day carries its venue's city, copied when it was made.
      where: { deleted_at: null, ...realEventsWhere, city: { not: null } },
      select: { id: true, title: true, city: true, latitude: true, longitude: true },
    })
    const folds = events.flatMap((e) => {
      const to = cityToStore(catalogue, e.city, e.latitude, e.longitude)
      return to !== e.city ? [{ ...e, to }] : []
    })
    for (const f of folds) console.log(`${f.id}  ${JSON.stringify(f.city)} -> ${JSON.stringify(f.to)}  (${f.title})`)
    console.log(`\n${folds.length} of ${events.length} events ${APPLY ? "updated" : "would change (dry run; --apply to write)"}`)
    if (!APPLY) return
    for (const f of folds) {
      // Only if the row still says what was read: a save in between wins.
      await db.events.updateMany({ where: { id: f.id, city: f.city }, data: { city: f.to } })
    }
  } finally {
    await db.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
