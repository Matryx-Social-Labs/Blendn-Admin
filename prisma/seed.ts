import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {
  console.log("🌱 Starting seed...")

  // Create admin user
  const hashedPassword = await bcrypt.hash("Matrix@2025", 12)
  const adminUser = await prisma.user.upsert({
    where: { email: "contact@matrixsociallabs.com" },
    update: {},
    create: {
      email: "contact@matrixsociallabs.com",
      name: "Admin",
      password: hashedPassword,
      image: null,
    },
  })
  console.log("✅ Created admin user:", adminUser.email)

  // Create test users
  const testUsers = [
    { email: "john@test.com", name: "John Smith", image: null },
    { email: "jane@test.com", name: "Jane Doe", image: null },
    { email: "mike@test.com", name: "Mike Johnson", image: null },
    { email: "sarah@test.com", name: "Sarah Williams", image: null },
    { email: "alex@test.com", name: "Alex Brown", image: null },
  ]

  const users = []
  for (const userData of testUsers) {
    const user = await prisma.user.upsert({
      where: { email: userData.email },
      update: {},
      create: {
        ...userData,
        password: await bcrypt.hash("Test@123", 12),
      },
    })
    users.push(user)
    console.log("✅ Created user:", user.email)
  }

  // Create profiles for users
  for (const user of users) {
    await prisma.profiles.upsert({
      where: { id: user.id },
      update: {},
      create: {
        id: user.id,
        name: user.name,
        age: Math.floor(Math.random() * 20) + 22, // 22-42
        location: ["San Francisco, CA", "New York, NY", "Los Angeles, CA", "Seattle, WA", "Austin, TX"][Math.floor(Math.random() * 5)],
        interests: ["Music", "Tech", "Food", "Sports", "Art"].slice(0, Math.floor(Math.random() * 3) + 2),
        onboarded: true,
      },
    })
  }
  console.log("✅ Created profiles for all users")

  // Create categories
  const categoriesData = [
    { name: "Music", slug: "music", icon: "🎵", description: "Live concerts, DJ sets, and music festivals" },
    { name: "Nightlife", slug: "nightlife", icon: "🌙", description: "Clubs, bars, and late-night events" },
    { name: "Food & Drink", slug: "food-drink", icon: "🍕", description: "Food festivals, tastings, and culinary experiences" },
    { name: "Sports", slug: "sports", icon: "⚽", description: "Sports events, games, and fitness activities" },
    { name: "Arts & Culture", slug: "arts-culture", icon: "🎨", description: "Art exhibitions, theater, and cultural events" },
    { name: "Tech", slug: "tech", icon: "💻", description: "Tech meetups, conferences, and workshops" },
    { name: "Networking", slug: "networking", icon: "🤝", description: "Professional networking and business events" },
    { name: "Outdoor", slug: "outdoor", icon: "🏕️", description: "Hiking, camping, and outdoor adventures" },
  ]

  const categories = []
  for (const catData of categoriesData) {
    const category = await prisma.categories.upsert({
      where: { slug: catData.slug },
      update: {},
      create: catData,
    })
    categories.push(category)
  }
  console.log("✅ Created", categories.length, "categories")

  // Cover images should be uploaded to Tigris storage via the admin dashboard.
  // Seed events will have no cover image until manually set.
  const coverImages: (string | null)[] = [null]

  // Bangalore coordinates
  const baseLocations = [
    { lat: 12.9716, lon: 77.5946, city: "Bangalore", venue: "Cubbon Park" },
    { lat: 12.9352, lon: 77.6245, city: "Bangalore", venue: "Koramangala Social" },
    { lat: 12.9698, lon: 77.7500, city: "Bangalore", venue: "Phoenix Marketcity" },
    { lat: 12.9279, lon: 77.6271, city: "Bangalore", venue: "Toit Brewpub" },
  ]

  // Create events - Bangalore only
  const eventsData = [
    {
      title: "Bangalore Tech Meetup",
      description: "Connect with fellow entrepreneurs and tech enthusiasts in the Silicon Valley of India. Pitch your ideas, find co-founders, and learn from successful founders.",
      short_description: "Network with tech founders",
      daysFromNow: 2,
      durationHours: 3,
      category: "tech",
    },
    {
      title: "Cubbon Park Music Festival",
      description: "Live music in the heart of Bangalore! Featuring local bands and artists. Food stalls and good vibes.",
      short_description: "Live music in Cubbon Park",
      daysFromNow: 7,
      durationHours: 6,
      category: "music",
    },
    {
      title: "Koramangala Food Walk",
      description: "Explore the best street food and restaurants in Koramangala. A guided food tour experience.",
      short_description: "Food tour in Koramangala",
      daysFromNow: 1,
      durationHours: 3,
      category: "food-drink",
    },
    {
      title: "Bangalore Startup Pitch Night",
      description: "Watch startups pitch to investors at one of India's top startup hubs. Great networking opportunity!",
      short_description: "Startups pitch to investors",
      daysFromNow: 5,
      durationHours: 3,
      category: "networking",
    },
  ]

  const createdEvents = []
  for (let i = 0; i < eventsData.length; i++) {
    const eventData = eventsData[i]
    const location = baseLocations[i % baseLocations.length]
    const category = categories.find(c => c.slug === eventData.category) || categories[0]

    const startTime = new Date()
    startTime.setDate(startTime.getDate() + eventData.daysFromNow)
    startTime.setHours(18, 0, 0, 0) // 6 PM

    const endTime = new Date(startTime)
    endTime.setHours(endTime.getHours() + eventData.durationHours)

    const slug = eventData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36) + i

    const event = await prisma.events.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        title: eventData.title,
        description: eventData.description,
        short_description: eventData.short_description,
        latitude: location.lat + (Math.random() - 0.5) * 0.01,
        longitude: location.lon + (Math.random() - 0.5) * 0.01,
        address: `${Math.floor(Math.random() * 999) + 1} Market Street`,
        venue_name: location.venue,
        city: location.city,
        state: "Karnataka",
        country: "India",
        postal_code: "560001",
        start_time: startTime,
        end_time: endTime,
        timezone: "America/Los_Angeles",
        status: "published",
        visibility: "public",
        max_capacity: Math.floor(Math.random() * 500) + 50,
        current_capacity: Math.floor(Math.random() * 30),
        organizer_id: users[i % users.length].id,
        cover_image_url: coverImages[i % coverImages.length],
        is_featured: i < 3, // First 3 are featured
        check_in_radius: 100, // 100 meters
      },
    })

    createdEvents.push(event)

    // Link event to category
    await prisma.event_categories.upsert({
      where: {
        event_id_category_id: {
          event_id: event.id,
          category_id: category.id,
        },
      },
      update: {},
      create: {
        event_id: event.id,
        category_id: category.id,
        primary: true,
      },
    })

    // Create chat group for event
    await prisma.chat_groups.upsert({
      where: { event_id: event.id },
      update: {},
      create: {
        event_id: event.id,
        name: `${eventData.title} Chat`,
        description: `Chat room for ${eventData.title}`,
        type: "event",
        status: "active",
      },
    })

    console.log("✅ Created event:", event.title)
  }

  console.log("\n🎉 Seed completed!")
  console.log(`   - ${users.length + 1} users created`)
  console.log(`   - ${categories.length} categories created`)
  console.log(`   - ${createdEvents.length} events created`)
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
