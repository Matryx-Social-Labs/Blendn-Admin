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
      image: "https://i.pravatar.cc/150?u=admin",
    },
  })
  console.log("✅ Created admin user:", adminUser.email)

  // Create test users
  const testUsers = [
    { email: "john@test.com", name: "John Smith", image: "https://i.pravatar.cc/150?u=john" },
    { email: "jane@test.com", name: "Jane Doe", image: "https://i.pravatar.cc/150?u=jane" },
    { email: "mike@test.com", name: "Mike Johnson", image: "https://i.pravatar.cc/150?u=mike" },
    { email: "sarah@test.com", name: "Sarah Williams", image: "https://i.pravatar.cc/150?u=sarah" },
    { email: "alex@test.com", name: "Alex Brown", image: "https://i.pravatar.cc/150?u=alex" },
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

  // Sample cover images (using Unsplash)
  const coverImages = [
    "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=800",
    "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=800",
    "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800",
    "https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?w=800",
    "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=800",
    "https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=800",
    "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800",
    "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800",
  ]

  // San Francisco coordinates
  const baseLocations = [
    { lat: 37.7749, lon: -122.4194, city: "San Francisco", venue: "The Fillmore" },
    { lat: 37.7849, lon: -122.4094, city: "San Francisco", venue: "Yerba Buena Gardens" },
    { lat: 37.8024, lon: -122.4058, city: "San Francisco", venue: "Pier 39" },
    { lat: 37.7694, lon: -122.4862, city: "San Francisco", venue: "Golden Gate Park" },
    { lat: 37.7879, lon: -122.4074, city: "San Francisco", venue: "Union Square" },
    { lat: 37.7599, lon: -122.4148, city: "San Francisco", venue: "The Castro Theater" },
    { lat: 37.7951, lon: -122.3934, city: "San Francisco", venue: "Ferry Building" },
    { lat: 37.8199, lon: -122.4783, city: "San Francisco", venue: "Presidio" },
  ]

  // Create events
  const eventsData = [
    {
      title: "Summer Music Festival 2026",
      description: "The biggest summer music festival featuring top artists from around the world. Three days of non-stop music, food, and fun!",
      short_description: "3 days of amazing music",
      daysFromNow: 7,
      durationHours: 8,
      category: "music",
    },
    {
      title: "Tech Startup Meetup",
      description: "Connect with fellow entrepreneurs and tech enthusiasts. Pitch your ideas, find co-founders, and learn from successful founders.",
      short_description: "Network with tech founders",
      daysFromNow: 2,
      durationHours: 3,
      category: "tech",
    },
    {
      title: "Rooftop Jazz Night",
      description: "Enjoy smooth jazz under the stars with breathtaking city views. Drinks and appetizers included.",
      short_description: "Jazz with city views",
      daysFromNow: 1,
      durationHours: 4,
      category: "music",
    },
    {
      title: "Food Truck Festival",
      description: "Over 50 food trucks serving cuisines from around the world. Live music, games, and family fun all day!",
      short_description: "50+ food trucks",
      daysFromNow: 5,
      durationHours: 6,
      category: "food-drink",
    },
    {
      title: "Art Gallery Opening",
      description: "Exclusive opening night for the new contemporary art exhibition featuring local and international artists.",
      short_description: "Contemporary art exhibition",
      daysFromNow: 3,
      durationHours: 3,
      category: "arts-culture",
    },
    {
      title: "Saturday Night Club",
      description: "The hottest club night in town! Top DJs, amazing atmosphere, and unforgettable vibes.",
      short_description: "Best club night in SF",
      daysFromNow: 0, // Today
      durationHours: 5,
      category: "nightlife",
    },
    {
      title: "Beach Volleyball Tournament",
      description: "Annual beach volleyball competition. Teams of all skill levels welcome. Prizes for top teams!",
      short_description: "Beach volleyball competition",
      daysFromNow: 10,
      durationHours: 6,
      category: "sports",
    },
    {
      title: "Hiking & Picnic Adventure",
      description: "Guided hike through beautiful trails followed by a group picnic. All fitness levels welcome.",
      short_description: "Nature hike & picnic",
      daysFromNow: 4,
      durationHours: 5,
      category: "outdoor",
    },
    {
      title: "Startup Pitch Night",
      description: "Watch startups pitch to investors and vote for your favorite. Great networking opportunity!",
      short_description: "Startups pitch to investors",
      daysFromNow: 6,
      durationHours: 3,
      category: "networking",
    },
    {
      title: "Wine Tasting Evening",
      description: "Sample premium wines from Napa Valley vineyards. Expert sommeliers will guide you through each tasting.",
      short_description: "Napa Valley wine tasting",
      daysFromNow: 8,
      durationHours: 3,
      category: "food-drink",
    },
    {
      title: "Comedy Night Live",
      description: "Laugh out loud with the city's best stand-up comedians. Two drink minimum.",
      short_description: "Stand-up comedy show",
      daysFromNow: 2,
      durationHours: 2,
      category: "arts-culture",
    },
    {
      title: "Yoga in the Park",
      description: "Free outdoor yoga session for all levels. Bring your mat and enjoy the fresh air!",
      short_description: "Free outdoor yoga",
      daysFromNow: 1,
      durationHours: 1,
      category: "outdoor",
    },
    {
      title: "Electronic Music Rave",
      description: "Underground rave featuring the best electronic music DJs. Prepare for an unforgettable night!",
      short_description: "Underground electronic rave",
      daysFromNow: 9,
      durationHours: 6,
      category: "nightlife",
    },
    {
      title: "Basketball Watch Party",
      description: "Catch the big game on the big screen with fellow fans. Drinks specials all night!",
      short_description: "Big game watch party",
      daysFromNow: 3,
      durationHours: 3,
      category: "sports",
    },
    {
      title: "AI & Machine Learning Workshop",
      description: "Hands-on workshop covering the latest in AI and ML. Laptops required. Beginners welcome!",
      short_description: "Learn AI & ML basics",
      daysFromNow: 12,
      durationHours: 4,
      category: "tech",
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
        state: "CA",
        country: "USA",
        postal_code: "94102",
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
