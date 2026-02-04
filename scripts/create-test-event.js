const { PrismaClient } = require('@prisma/client')
const slugify = require('slugify')

const prisma = new PrismaClient()

async function main() {
  const now = Date.now()
  const targetEventId = process.env.EVENT_ID
  let eventId = targetEventId || null

  if (!eventId) {
    const email = `test-organizer+${now}@blendn.local`
    const name = 'Test Organizer'

    const organizer = await prisma.user.create({
      data: {
        email,
        name,
      },
    })

    const title = 'Test event'
    const slug = slugify(`${title}-${now}`, { lower: true, strict: true })
    const startTime = new Date('2026-02-04T05:00:00+05:30')
    const endTime = new Date('2026-02-14T12:00:00+05:30')

    const event = await prisma.events.create({
      data: {
        slug,
        title,
        description: 'Test event created via script.',
        short_description: 'Test event',
        latitude: 12.969553,
        longitude: 77.53601,
        address: 'Test Location',
        venue_name: 'Test Venue',
        city: 'Bengaluru',
        state: 'Karnataka',
        country: 'India',
        postal_code: '560001',
        start_time: startTime,
        end_time: endTime,
        timezone: 'Asia/Kolkata',
        status: 'published',
        visibility: 'public',
        organizer_id: organizer.id,
        check_in_radius: 10000,
      },
    })

    eventId = event.id
    console.log('Created organizer:', organizer.id, organizer.email)
    console.log('Created event:', event.id, event.slug)
  } else {
    console.log('Using existing event:', eventId)
  }

  const avatarPool = [
    'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=facearea&w=300&h=300&q=70',
    'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=facearea&w=300&h=300&q=70',
    'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=facearea&w=300&h=300&q=70',
    'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=facearea&w=300&h=300&q=70&sat=-20',
    'https://images.unsplash.com/photo-1544723795-3fb6469f5b39?auto=format&fit=facearea&w=300&h=300&q=70',
    'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=facearea&w=300&h=300&q=70',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=facearea&w=300&h=300&q=70',
    'https://images.unsplash.com/photo-1525134479668-1bee5c7c6845?auto=format&fit=facearea&w=300&h=300&q=70',
    'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?auto=format&fit=facearea&w=300&h=300&q=70',
    'https://images.unsplash.com/photo-1544723795-3fb6469f5b39?auto=format&fit=facearea&w=300&h=300&q=70&sat=10',
  ]

  const dummyUsers = await Promise.all(
    [...Array(10)].map(async (_, idx) => {
      const userEmail = `test-attendee+${now}-${idx}@blendn.local`
      const userName = `Test User ${idx + 1}`
      const userImage = avatarPool[idx % avatarPool.length]

      const user = await prisma.user.create({
        data: {
          email: userEmail,
          name: userName,
          image: userImage,
        },
      })

      await prisma.profiles.create({
        data: {
          id: user.id,
          name: userName,
          age: 21 + (idx % 10),
          interests: ['Networking', 'Tech', 'Music', 'Startups'].slice(0, 2 + (idx % 3)),
          onboarded: true,
        },
      })

      return user
    })
  )

  await Promise.all(
    dummyUsers.map((user, idx) =>
      prisma.event_check_ins.create({
        data: {
          event_id: eventId,
          user_id: user.id,
          status: 'checked_in',
          check_in_time: new Date(Date.now() - idx * 5 * 60 * 1000),
          latitude: 12.969553,
          longitude: 77.53601,
        },
      })
    )
  )

  console.log('Created attendees:', dummyUsers.length)
  console.log('Checked in attendees to event.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
