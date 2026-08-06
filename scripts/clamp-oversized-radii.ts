import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { GEOFENCE_LIMITS, validateGeofence, type Geofence } from "../lib/geofence"

/**
 * Bring pre-cap check-in radii back inside the cap.
 *
 * `check_in_radius` used to have no server-side ceiling, and one number was
 * doing three jobs — the venue's size, the organiser's tolerance, and slack for
 * bad GPS. Faced with attendees who could not check in, the only lever was to
 * make the circle bigger. A real ISL match at Sri Kanteerava ended up at
 * **100 km**, which is most of Bengaluru.
 *
 * v0.29.0 capped new writes at 2000 m. It did not touch existing rows, so the
 * fix has to be run once.
 *
 * ## Why this is safe to run
 *
 * Every affected event is in the past, and nothing re-validates a stored
 * check-in — the route decides at check-in time and writes the row. So this
 * changes what *would* happen, not what did.
 *
 * ## Why it writes a geofence rather than just truncating the number
 *
 * Truncating 100000 to 2000 would leave the same mistake, two orders of
 * magnitude smaller. The geofence separates the three quantities, so the venue's
 * extent stays honest and GPS slack is applied per check-in from the device's
 * own reported accuracy.
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/clamp-oversized-radii.ts          # dry run
 *   DATABASE_URL=... npx tsx scripts/clamp-oversized-radii.ts --apply
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

/**
 * Extent by what the venue actually is, not by what the old number said.
 *
 * Deliberately keyed on the venue name rather than derived: these are five
 * known rows, and a clever heuristic here would be untestable and wrong more
 * often than a list.
 */
function extentFor(venueName: string | null, title: string): { extent: number; buffer: number } {
  const haystack = `${venueName ?? ""} ${title}`.toLowerCase()
  // A stadium bowl plus its concourse. Sri Kanteerava's own footprint is ~150 m
  // across; the buffer covers the gates and the queue outside them.
  if (/stadium|kanteerava/.test(haystack)) return { extent: 150, buffer: 80 }
  // Multi-stage outdoor festivals genuinely spread out.
  if (/festival|sixth sense/.test(haystack)) return { extent: 250, buffer: 100 }
  // Everything else — a club night, a test row.
  return { extent: 60, buffer: 40 }
}

async function main() {
  const apply = process.argv.includes("--apply")

  const rows = await db.events.findMany({
    where: { deleted_at: null, check_in_radius: { gt: GEOFENCE_LIMITS.MAX_RADIUS } },
    select: {
      id: true,
      title: true,
      venue_name: true,
      check_in_radius: true,
      latitude: true,
      longitude: true,
      geofence: true,
      start_time: true,
    },
    orderBy: { check_in_radius: "desc" },
  })

  if (rows.length === 0) {
    console.log("Nothing over the cap.")
    return
  }

  console.log(`${rows.length} event(s) over ${GEOFENCE_LIMITS.MAX_RADIUS} m\n`)

  for (const row of rows) {
    const { extent, buffer } = extentFor(row.venue_name, row.title)
    const label = `${row.title.slice(0, 44)} @ ${row.venue_name ?? "—"}`

    if (row.latitude === null || row.longitude === null) {
      // Without a pin there is no circle to draw. Clamping the legacy number is
      // still strictly better than 100 km, and the check-in route refuses an
      // event with no coordinates anyway.
      console.log(`  ${row.check_in_radius} m → ${GEOFENCE_LIMITS.MAX_RADIUS} m (no pin)  ${label}`)
      if (apply) {
        await db.events.update({
          where: { id: row.id },
          data: { check_in_radius: GEOFENCE_LIMITS.MAX_RADIUS },
        })
      }
      continue
    }

    const fence: Geofence = {
      type: "circle",
      lat: row.latitude,
      lng: row.longitude,
      radius: extent,
      buffer,
    }

    // The same validator the API uses. A migration that writes something the
    // runtime would reject is worse than no migration.
    const parsed = validateGeofence(fence)
    if (!parsed.ok) {
      console.log(`  SKIPPED — ${parsed.error}  ${label}`)
      continue
    }

    console.log(
      `  ${row.check_in_radius} m → ${extent} m extent + ${buffer} m buffer` +
        `${row.geofence ? " (overwriting existing fence)" : ""}  ${label}`
    )

    if (apply) {
      await db.events.update({
        where: { id: row.id },
        data: {
          geofence: parsed.fence as object,
          // Older mobile builds in the wild still read check_in_radius, so it
          // has to stay consistent with the fence rather than merely legal.
          check_in_radius: extent + buffer,
        },
      })
    }
  }

  console.log(apply ? "\nApplied." : "\nDry run. Re-run with --apply to write.")
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
