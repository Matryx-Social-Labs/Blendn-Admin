import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { eventCentre } from "../lib/geofence"
import { haversineDistanceMeters } from "../lib/geo"
import { reverseGeocodeCity } from "../lib/location"

/**
 * Re-derive every event's city and pin from the map, once.
 *
 * Three screens used to answer "which city is this pin in?" three different
 * ways — `lib/location.ts`, `components/location-picker.tsx` and
 * `components/venue-create-form.tsx`, each with its own fallback chain, and
 * only one of them asking Nominatim for English. So the same place could be
 * stored as the village, as the surrounding district, or in the local language,
 * depending on which form the organiser happened to open.
 *
 * `lib/address.ts` is now the single chain and the proxy pins the language, so
 * new writes agree. This fixes the rows written before that.
 *
 * ## It also un-drifts the pin
 *
 * Drawing a polygon never wrote back to `latitude`/`longitude`, so an organiser
 * could pin their office, trace a stadium five kilometres away and save both.
 * The fence was right and check-in worked; the pin was wrong and it is the pin
 * that "Nearby" sorts by. Anywhere the fence and the pin disagree by more than
 * `DRIFT_METRES`, the fence wins — see `eventCentre`.
 *
 * ## Why a script and not a migration
 *
 * It calls a geocoder, so it is slow, rate-limited and can partially fail. A
 * migration that hangs on a third-party outage blocks a deploy; this can be
 * re-run and is idempotent.
 *
 * Nominatim's usage policy is **one request per second**, and being blocked
 * would take out the authoring flow for everyone. `THROTTLE_MS` is not tuning.
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/backfill-event-cities.ts          # dry run
 *   DATABASE_URL=... npx tsx scripts/backfill-event-cities.ts --apply
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

const APPLY = process.argv.includes("--apply")

/** OSM's policy is 1 req/s. Do not lower this. */
const THROTTLE_MS = 1100

/**
 * How far the pin may sit from the fence before it counts as drift.
 *
 * Generous on purpose. A circle's centre and its own pin normally agree
 * exactly; a traced polygon's centroid lands a few tens of metres off whatever
 * the organiser originally clicked, and rewriting the pin for that would be
 * churn with no benefit. 250m is past the size of most venues, so anything
 * beyond it is a genuinely different place rather than drawing slack.
 */
const DRIFT_METRES = 250

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const events = await db.events.findMany({
    where: { deleted_at: null },
    select: {
      id: true,
      title: true,
      city: true,
      latitude: true,
      longitude: true,
      geofence: true,
    },
  })

  console.log(`${events.length} events\n`)

  let pinFixed = 0
  let cityFixed = 0
  let unlocatable = 0
  let geocodeFailed = 0

  for (const event of events) {
    const centre = eventCentre(event.geofence, event.latitude, event.longitude)

    if (!centre) {
      // No fence and no pin. Nothing to derive from, and inventing a location
      // would be worse than leaving it blank — this event genuinely does not
      // know where it is.
      unlocatable++
      console.log(`  ?  ${event.title} — no fence and no pin`)
      continue
    }

    const drift =
      event.latitude != null && event.longitude != null
        ? haversineDistanceMeters(event.latitude, event.longitude, centre.lat, centre.lng)
        : Infinity

    const pinMoved = drift > DRIFT_METRES

    await sleep(THROTTLE_MS)
    const city = await reverseGeocodeCity(centre.lat, centre.lng)

    if (city === null) {
      // Upstream said nothing. Leave the stored city alone rather than clearing
      // it — a geocoder outage must not blank every event's city.
      geocodeFailed++
      console.log(`  !  ${event.title} — geocoder returned nothing, left as ${event.city ?? "null"}`)
      continue
    }

    const cityChanged = city !== event.city

    if (!pinMoved && !cityChanged) continue

    if (pinMoved) {
      pinFixed++
      console.log(
        `  →  ${event.title} — pin moved ${Math.round(drift)}m to the fence centre`
      )
    }
    if (cityChanged) {
      cityFixed++
      console.log(`  →  ${event.title} — city ${event.city ?? "null"} → ${city}`)
    }

    if (APPLY) {
      await db.events.update({
        where: { id: event.id },
        data: {
          city,
          ...(pinMoved ? { latitude: centre.lat, longitude: centre.lng } : {}),
        },
      })
    }
  }

  console.log(
    `\n${cityFixed} cities, ${pinFixed} pins${APPLY ? " updated" : " would change"}` +
      `\n${unlocatable} with no location at all, ${geocodeFailed} the geocoder could not name`
  )
  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.")
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
