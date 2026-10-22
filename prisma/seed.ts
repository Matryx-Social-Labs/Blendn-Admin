import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { ensureTestAccounts } from "../scripts/test-accounts"

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

// --- Main seed ---

async function main() {
  console.log("🌱 Starting seed...")

  /*
   * The role accounts people sign in as (`scripts/test-accounts.ts`), and the
   * organiser the events below belong to.
   *
   * This used to create `contact@matrixsociallabs.com` — a real person's
   * address — and five `@test.com` users, with their passwords written here in
   * plain text. It also left the events without an organisation, so no
   * organiser could see them: access is organisation-shaped (`lib/rbac.ts`).
   */
  const password = process.env.SEED_PASSWORD?.trim()
  if (!password) throw new Error("Set SEED_PASSWORD — the seeded accounts' password.")
  const { users, orgs } = await ensureTestAccounts(prisma, password)
  console.log("✅ Role accounts ready: admin@, organizer@, venue.owner@, sponsor@blendn.app")

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

  // 7 real Bengaluru events from district.in
  const eventsData = [
    {
      title: "Paradox presents Baby J b2b Tye Turner",
      description: "The inaugural appearance of Baby J and Tye Turner performing together in Bengaluru. Expect high-energy selections, seamless flow, and the underground sound that's made them a favorite across India's dance floors. Elevated production, immersive lighting, and the charged energy of Bengaluru.",
      short_description: "Underground DJ duo live at Sunburn Union",
      start_time: new Date("2026-02-21T17:00:00+05:30"),
      end_time: new Date("2026-02-21T22:00:00+05:30"),
      venue_name: "Sunburn Union",
      address: "Passport Office, Mantri Avenue, next to Koramangala, KHB Games Village, Koramangala, Bengaluru",
      lat: 12.9352,
      lon: 77.6245,
      category: "nightlife",
      capacity: 500,
      is_featured: true,
    },
    {
      title: "The Sixth Sense 2026",
      description: "India's first and largest multidisciplinary immersive festival set in a historic glass factory. Features 15+ immersive art-tech installations with a 360° dome experience, curated live music performances, and collaborative workshops. Artists include Vieux Farka Touré, Niladri Kumaar, Batavia Collective, Max Cooper, and Luke Slater.",
      short_description: "Immersive art-tech festival in a glass factory",
      start_time: new Date("2026-02-13T09:30:00+05:30"),
      end_time: new Date("2026-02-22T17:30:00+05:30"),
      venue_name: "The Sixth Sense Festival",
      address: "Maithri Layout, Kadugodi, Bengaluru, Karnataka 560067",
      lat: 12.9900,
      lon: 77.7600,
      category: "arts-culture",
      capacity: 1000,
      is_featured: true,
    },
    {
      title: "ISL 2025-26: Bengaluru FC vs Sporting Club Delhi",
      description: "Get ready to cheer for Bengaluru FC as they step onto the pitch for an electrifying Indian Super League showdown against Sporting Club Delhi. High-octane action, crowd-roaring excitement, and the true essence of matchday football. Experience the passionate fan base, sharp attacking play, and never-back-down spirit.",
      short_description: "ISL matchday at Kanteerava Stadium",
      start_time: new Date("2026-02-15T19:30:00+05:30"),
      end_time: new Date("2026-02-15T22:30:00+05:30"),
      venue_name: "Sri Kanteerava Stadium",
      address: "23, Fort Rd, near Kanteerava Stadium, Sampangi Rama Nagara, Bengaluru, Karnataka 560027",
      lat: 12.9716,
      lon: 77.5946,
      category: "sports",
      capacity: 18000,
      is_featured: true,
    },
    {
      title: "Soul Jams Bengaluru Valentine's Edition",
      description: "An evening of relaxation, unwinding, and rejuvenation in a welcoming community space. Bring your instruments or simply enjoy performances. Features an open-mic session for performers of all levels, a networking circle to connect with like-minded individuals, and spontaneous group jamming.",
      short_description: "Open-mic jam session for Valentine's",
      start_time: new Date("2026-02-14T17:00:00+05:30"),
      end_time: new Date("2026-02-14T20:30:00+05:30"),
      venue_name: "Macaw By Stories",
      address: "Bommanahalli, Bengaluru",
      lat: 12.9010,
      lon: 77.6240,
      category: "music",
      capacity: 150,
      is_featured: true,
    },
    {
      title: "Karan Aujla P-Pop Culture India Tour - Bengaluru",
      description: "Get ready for the ultimate musical experience as Karan Aujla, the global Punjabi sensation, takes over India with the P Pop Culture Tour! Chart-topping tracks and a power-packed performance blending Punjabi beats, hip-hop energy, and pop culture flair. Electrifying music, larger-than-life production, and unstoppable vibes.",
      short_description: "Karan Aujla live in Bengaluru",
      start_time: new Date("2026-03-29T18:00:00+05:30"),
      end_time: new Date("2026-03-29T22:00:00+05:30"),
      venue_name: "Venue TBA",
      address: "Bengaluru, Karnataka",
      lat: 12.9716,
      lon: 77.5946,
      category: "music",
      capacity: 10000,
      is_featured: true,
    },
    {
      title: "Sauvage | Chef Priyam x Chef Rishab at Fireside",
      description: "For three days only, Fireside hosts an extraordinary collaboration. Two French chefs Priyam & Rishab step into the open wood-fire kitchen to cook alongside Chef Rajat Alve. United by one obsession: FIRE. No gas. No shortcuts. Just flame, smoke, technique, and instinct.",
      short_description: "Fire-cooking chef collaboration at Fireside",
      start_time: new Date("2026-02-20T19:00:00+05:30"),
      end_time: new Date("2026-02-22T21:00:00+05:30"),
      venue_name: "Fireside: Flame Craft Dining",
      address: "Kalyan Nagar, Bengaluru",
      lat: 13.0250,
      lon: 77.6400,
      category: "food-drink",
      capacity: 40,
      is_featured: false,
    },
    {
      title: "HG Music Showcase: Reble, Rae Mulla & More",
      description: "India's next-gen music label by Homegrown x Atlantic Records hosts its inaugural showcase during The Humming Tree's reopening weekend. Headliner Reble, one of India's fastest-rising hip hop voices, alongside Mumbai-based rapper Rae Mulla. A contemporary 12,000-square-foot performance space with 600+ capacity, professional sound and lighting.",
      short_description: "Hip-hop showcase at The Humming Tree",
      start_time: new Date("2026-02-20T20:00:00+05:30"),
      end_time: new Date("2026-02-21T01:00:00+05:30"),
      venue_name: "The Humming Tree",
      address: "Shop No. 763, 100 Feet Rd, next to Xtreme Sports Bar, HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560008",
      lat: 12.9784,
      lon: 77.6408,
      category: "music",
      capacity: 600,
      is_featured: false,
    },
  ]

  // Clean up this seed's previous events: same organiser, same titles. Never
  // everything the organiser owns — `seed:qa` puts its world there too.
  const oldEvents = await prisma.events.findMany({
    where: { organizer_id: users.organiser, title: { in: eventsData.map((e) => e.title) } },
    select: { id: true },
  })
  if (oldEvents.length > 0) {
    const oldEventIds = oldEvents.map(e => e.id)
    await prisma.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: oldEventIds } } } })
    await prisma.chat_groups.deleteMany({ where: { event_id: { in: oldEventIds } } })
    await prisma.event_categories.deleteMany({ where: { event_id: { in: oldEventIds } } })
    await prisma.event_check_ins.deleteMany({ where: { event_id: { in: oldEventIds } } })
    await prisma.event_favorites.deleteMany({ where: { event_id: { in: oldEventIds } } })
    await prisma.events.deleteMany({ where: { id: { in: oldEventIds } } })
    console.log(`🧹 Cleaned up ${oldEvents.length} old seed events`)
  }

  const createdEvents = []
  for (let i = 0; i < eventsData.length; i++) {
    const eventData = eventsData[i]
    const category = categories.find(c => c.slug === eventData.category) || categories[0]

    const slug = eventData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36) + i

    const event = await prisma.events.create({
      data: {
        slug,
        title: eventData.title,
        description: eventData.description,
        short_description: eventData.short_description,
        latitude: eventData.lat + (Math.random() - 0.5) * 0.002,
        longitude: eventData.lon + (Math.random() - 0.5) * 0.002,
        address: eventData.address,
        venue_name: eventData.venue_name,
        city: "Bengaluru",
        state: "Karnataka",
        country: "India",
        postal_code: "560001",
        start_time: eventData.start_time,
        end_time: eventData.end_time,
        timezone: "Asia/Kolkata",
        status: "published",
        visibility: "public",
        max_capacity: eventData.capacity,
        current_capacity: Math.floor(Math.random() * Math.min(30, eventData.capacity)),
        organizer_id: users.organiser,
        organizer_org_id: orgs.events.id,
        cover_image_url: null,
        is_featured: eventData.is_featured,
        check_in_radius: 100,
      },
    })

    createdEvents.push(event)

    // Link event to category
    await prisma.event_categories.create({
      data: {
        event_id: event.id,
        category_id: category.id,
        primary: true,
      },
    })

    // Create chat group for event
    await prisma.chat_groups.create({
      data: {
        event_id: event.id,
        name: `${eventData.title} Chat`,
        description: `Chat room for ${eventData.title}`,
        type: "event",
        status: "active",
      },
    })

    console.log(`✅ Created event: ${event.title}`)
  }

  console.log("\n🎉 Seed completed!")
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
