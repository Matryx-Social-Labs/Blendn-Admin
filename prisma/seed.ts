import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import fs from "fs"
import path from "path"

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

// --- Tigris image upload helpers ---

const TIGRIS_ENDPOINT = process.env.TIGRIS_ENDPOINT || ""
const TIGRIS_ACCESS_KEY = process.env.TIGRIS_ACCESS_KEY || ""
const TIGRIS_SECRET_KEY = process.env.TIGRIS_SECRET_KEY || ""
const TIGRIS_BUCKET = process.env.TIGRIS_BUCKET || "blendn-media"
const TIGRIS_REGION = process.env.TIGRIS_REGION || "auto"

function isTigrisConfigured(): boolean {
  return !!(TIGRIS_ENDPOINT && TIGRIS_ACCESS_KEY && TIGRIS_SECRET_KEY)
}

function getTigrisClient(): S3Client {
  return new S3Client({
    endpoint: TIGRIS_ENDPOINT,
    region: TIGRIS_REGION,
    credentials: {
      accessKeyId: TIGRIS_ACCESS_KEY,
      secretAccessKey: TIGRIS_SECRET_KEY,
    },
    forcePathStyle: true,
  })
}

function getTigrisPublicUrl(key: string): string {
  return `https://${TIGRIS_BUCKET}.fly.storage.tigris.dev/${key}`
}

async function uploadToTigris(
  client: S3Client,
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  await client.send(
    new PutObjectCommand({
      Bucket: TIGRIS_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000",
    })
  )
  return getTigrisPublicUrl(key)
}

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".webp") return "image/webp"
  return "image/jpeg"
}

// Local image files mapped to each event (in prisma/seed-images/)
const SEED_IMAGE_FILES = [
  "snggnbh3bgutilnhm22y.webp",                                    // Paradox Baby J b2b Tye Turner
  "c_crop,g_custom_v1770111150_hpcqu1byg51zrapodpx9.jpg",          // The Sixth Sense 2026
  "c_crop,g_custom_v1770404217_yg7uennjs3lp7ib3vny4.jpg",          // BFC vs Sporting Club Delhi
  "c_crop,g_custom_v1770382025_gblhdki7b4qdvydgnkzc.png",          // Soul Jams Valentine's
  "c_crop,g_custom_v1764142943_gaqts0blrdpxuox4ukfa.jpg",          // Karan Aujla P-Pop Culture
  "c_crop,g_custom_v1770369611_uhlez0ie2r6xv0uatkbw.jpg",          // Sauvage Chef Collab (reused for chef event)
  "c_crop,g_custom_v1770675196_dzdem7x0nbyr194ltgxt.png",          // HG Music Showcase (reused)
]

async function uploadSeedImages(): Promise<(string | null)[]> {
  if (!isTigrisConfigured()) {
    console.log("⚠️  Tigris not configured — events will have no cover images")
    return SEED_IMAGE_FILES.map(() => null)
  }

  console.log("📸 Uploading seed images to Tigris from local files...")
  const client = getTigrisClient()
  const seedImagesDir = path.join(__dirname, "seed-images")
  const urls: (string | null)[] = []

  for (let i = 0; i < SEED_IMAGE_FILES.length; i++) {
    const filename = SEED_IMAGE_FILES[i]
    const filePath = path.join(seedImagesDir, filename)
    try {
      const imageBuffer = fs.readFileSync(filePath)
      const contentType = getContentType(filename)
      const ext = path.extname(filename)
      const key = `events/seed/event-cover-${i}${ext}`
      const publicUrl = await uploadToTigris(client, key, imageBuffer, contentType)
      urls.push(publicUrl)
      console.log(`  ✅ Uploaded image ${i + 1}/${SEED_IMAGE_FILES.length}: ${filename}`)
    } catch (err) {
      console.warn(`  ⚠️  Failed to upload image ${i + 1} (${filename}):`, err instanceof Error ? err.message : err)
      urls.push(null)
    }
  }

  return urls
}

// --- Main seed ---

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
        age: Math.floor(Math.random() * 20) + 22,
        location: "Bangalore, KA",
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

  // Clean up old seed events (created by seed test users)
  const seedUserIds = users.map(u => u.id)
  const oldEvents = await prisma.events.findMany({
    where: { organizer_id: { in: seedUserIds } },
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

  // Upload seed images to Tigris (or get nulls if not configured)
  const coverImages = await uploadSeedImages()

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
        organizer_id: users[i % users.length].id,
        cover_image_url: coverImages[i] ?? null,
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

    console.log(`✅ Created event: ${event.title}${coverImages[i] ? ' (with image)' : ''}`)
  }

  console.log("\n🎉 Seed completed!")
  console.log(`   - ${users.length + 1} users created`)
  console.log(`   - ${categories.length} categories created`)
  console.log(`   - ${createdEvents.length} events created`)
  console.log(`   - ${coverImages.filter(Boolean).length} cover images uploaded`)
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
