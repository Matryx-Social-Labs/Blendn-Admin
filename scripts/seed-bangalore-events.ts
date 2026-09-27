import { PrismaClient } from '@prisma/client'
import { PrismaPg } from "@prisma/adapter-pg"

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

/**
 * Raw insert, not `prisma.events.create()`: the staging database is missing
 * several columns the local schema.prisma declares (door_policy, min_age,
 * source_url, claimed_at, curated_at) — a pending migration never applied to
 * staging. Rather than touch that (out of scope here), this only writes
 * columns confirmed to exist live.
 */

/**
 * Ten dev/test events spread across Bangalore, dated over the next couple
 * weeks so they show up as "upcoming" regardless of when this is run.
 *
 * `check_in_radius` is set generously (15km) rather than a realistic venue
 * radius, specifically so a check-in works from anywhere in the city during
 * testing — do not copy this value into a real event.
 */
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const CHECK_IN_RADIUS_M = 15000

const VENUES = [
  { title: 'Indiranagar Rooftop Mixer', venue_name: '100 Feet Road Rooftop', address: '100 Feet Road, Indiranagar, Bengaluru', lat: 12.9716, lng: 77.6412, postal: '560038', startOffsetDays: 1, durationHours: 4 },
  { title: 'Koramangala Founders Night', venue_name: 'Third Wave Coffee, Koramangala', address: '80 Feet Road, Koramangala, Bengaluru', lat: 12.9352, lng: 77.6245, postal: '560034', startOffsetDays: 2, durationHours: 3 },
  { title: 'Cubbon Park Morning Run Club', venue_name: 'Cubbon Park Bandstand', address: 'Cubbon Park, Bengaluru', lat: 12.9763, lng: 77.5929, postal: '560001', startOffsetDays: 3, durationHours: 2 },
  { title: 'UB City Wine & Design', venue_name: 'UB City Mall', address: 'Vittal Mallya Road, Bengaluru', lat: 12.9716, lng: 77.5960, postal: '560001', startOffsetDays: 4, durationHours: 3 },
  { title: 'HSR Layout Board Game Night', venue_name: 'The Hangout Café, HSR Layout', address: '27th Main, HSR Layout, Bengaluru', lat: 12.9116, lng: 77.6389, postal: '560102', startOffsetDays: 5, durationHours: 3 },
  { title: 'Whitefield Tech Meetup', venue_name: 'ITPL Tech Park', address: 'Whitefield, Bengaluru', lat: 12.9698, lng: 77.7500, postal: '560066', startOffsetDays: 6, durationHours: 3 },
  { title: 'Church Street Live Sessions', venue_name: 'Church Street Social', address: 'Church Street, Bengaluru', lat: 12.9750, lng: 77.6058, postal: '560001', startOffsetDays: 7, durationHours: 4 },
  { title: 'Jayanagar Sunday Market Blend', venue_name: 'Jayanagar 4th Block', address: '4th Block, Jayanagar, Bengaluru', lat: 12.9250, lng: 77.5938, postal: '560011', startOffsetDays: 8, durationHours: 3 },
  { title: 'Electronic City Rooftop Cinema', venue_name: 'Neon Sky Terrace', address: 'Electronic City Phase 1, Bengaluru', lat: 12.8452, lng: 77.6602, postal: '560100', startOffsetDays: 9, durationHours: 3 },
  { title: 'MG Road Photowalk & Blend', venue_name: 'MG Road Metro Plaza', address: 'MG Road, Bengaluru', lat: 12.9758, lng: 77.6045, postal: '560001', startOffsetDays: 10, durationHours: 2 },
]

async function main() {
  const organizer = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!organizer) {
    console.error('No users found in database. Please create a user first.')
    process.exit(1)
  }
  console.log(`Using organizer: ${organizer.name} (${organizer.id})`)

  const created: { id: string; title: string; start_time: Date }[] = []

  for (const v of VENUES) {
    const start_time = new Date(Date.now() + v.startOffsetDays * DAY)
    const end_time = new Date(start_time.getTime() + v.durationHours * HOUR)

    const slug = `${v.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`
    const description = `${v.title} — a dev/test event in Bengaluru for verifying the app end to end. Join us for networking and fun!`
    const short_description = `Test event at ${v.venue_name}`

    const rows: { id: string }[] = await prisma.$queryRawUnsafe(
      `INSERT INTO events (
         id, slug, title, description, short_description,
         latitude, longitude, address, venue_name,
         city, state, country, postal_code,
         start_time, end_time, timezone,
         status, visibility, max_capacity, current_capacity,
         organizer_id, check_in_radius, is_featured,
         created_at, updated_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15,
         'published', 'public', 100, 0,
         $16, $17, false,
         now(), now()
       ) RETURNING id`,
      slug, v.title, description, short_description,
      v.lat, v.lng, v.address, v.venue_name,
      'Bengaluru', 'Karnataka', 'India', v.postal,
      start_time, end_time, 'Asia/Kolkata',
      organizer.id, CHECK_IN_RADIUS_M
    )

    created.push({ id: rows[0].id, title: v.title, start_time })
    console.log(`Created: ${v.title} — ${start_time.toISOString()}`)
  }

  console.log(`\nDone. ${created.length} events created in Bengaluru, check-in radius ${CHECK_IN_RADIUS_M}m.`)
}

main()
  .catch((e) => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
