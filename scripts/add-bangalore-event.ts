import { PrismaClient } from '@prisma/client'
import { PrismaPg } from "@prisma/adapter-pg"

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

async function main() {
  // Find an organizer (first user in the system)
  const organizer = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' }
  })

  if (!organizer) {
    console.error('No users found in database. Please create a user first.')
    process.exit(1)
  }

  console.log(`Using organizer: ${organizer.name} (${organizer.id})`)

  // Create the event
  const event = await prisma.events.create({
    data: {
      slug: `bangalore-test-event-${Date.now()}`,
      title: 'Bangalore Test Event',
      description: 'A test event in Bangalore for development and testing purposes. Join us for networking and fun!',
      short_description: 'Test event in Bangalore',
      latitude: 12.969421,
      longitude: 77.536039,
      address: 'Bangalore, Karnataka, India',
      venue_name: 'Bangalore Test Venue',
      city: 'Bangalore',
      state: 'Karnataka',
      country: 'India',
      postal_code: '560001',
      start_time: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
      end_time: new Date(Date.now() + 28 * 60 * 60 * 1000), // Tomorrow + 4 hours
      timezone: 'Asia/Kolkata',
      status: 'published',
      visibility: 'public',
      max_capacity: 100,
      current_capacity: 0,
      organizer_id: organizer.id,
      check_in_radius: 10000, // 10000 meters = 10km
      is_featured: true,
    }
  })

  console.log('Event created successfully!')
  console.log(`Event ID: ${event.id}`)
  console.log(`Title: ${event.title}`)
  console.log(`Location: ${event.latitude}, ${event.longitude}`)
  console.log(`Check-in radius: ${event.check_in_radius}m`)
  console.log(`Start time: ${event.start_time}`)
  console.log(`Status: ${event.status}`)
}

main()
  .catch((e) => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
