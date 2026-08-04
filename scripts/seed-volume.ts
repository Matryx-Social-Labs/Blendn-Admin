/**
 * Generate realistic data volume so performance can actually be measured.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-volume.ts
 *   DATABASE_URL=... npx tsx scripts/seed-volume.ts --clean    # remove it again
 *
 * Why this exists: with 361 chat messages the largest table is 208 kB, so
 * Postgres picks a sequential scan for everything and every query returns in
 * ~0.1ms. That is not "fast", it is "too small to measure". Index choices only
 * start to matter around 10^5-10^6 rows, so benchmarks and EXPLAIN plans taken
 * at current volume tell you nothing about how the app behaves later.
 *
 * Uses INSERT ... SELECT generate_series rather than Prisma createMany:
 * 500k rows round-tripped through the client takes minutes, in-database takes
 * seconds. This is a load generator, not application code.
 *
 * Everything it writes is namespaced `perfseed_` so --clean can remove exactly
 * what it added and nothing else.
 */
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

const TAG = "perfseed"

const SCALE = {
  users: 10_000,
  events: 2_000,
  messagesPerGroup: 500,
  checkins: 50_000,
}

async function clean() {
  console.log("removing perfseed data...")
  // Delete through INDEXED foreign keys, not `LIKE` on the tag. A first version
  // used `WHERE user_id LIKE 'perfseed_%'` and could not finish in 10 minutes:
  // on 500k rows that is an unindexed pattern match per row. Going via
  // chat_group_id / event_id uses the existing indexes instead.
  //
  // Everything below hangs off the seeded events, so deleting those cascades
  // most of it — but the order is still explicit so a partial run is safe to
  // re-run.
  const eventIds = `SELECT id FROM events WHERE slug LIKE '${TAG}-%'`
  const groupIds = `SELECT id FROM chat_groups WHERE event_id IN (${eventIds})`

  const steps: [string, string][] = [
    ["chat_messages", `DELETE FROM chat_messages WHERE chat_group_id IN (${groupIds})`],
    ["chat_group_members", `DELETE FROM chat_group_members WHERE chat_group_id IN (${groupIds})`],
    ["chat_groups", `DELETE FROM chat_groups WHERE event_id IN (${eventIds})`],
    ["event_check_ins", `DELETE FROM event_check_ins WHERE event_id IN (${eventIds})`],
    ["event_rsvps", `DELETE FROM event_rsvps WHERE event_id IN (${eventIds})`],
    ["events", `DELETE FROM events WHERE slug LIKE '${TAG}-%'`],
    ["profiles", `DELETE FROM profiles WHERE id LIKE '${TAG}_%'`],
    ["User", `DELETE FROM "User" WHERE id LIKE '${TAG}_%'`],
  ]
  for (const [label, sql] of steps) {
    const n = await db.$executeRawUnsafe(sql)
    console.log(`  ${label.padEnd(20)} -${n}`)
  }
  await db.$executeRawUnsafe(`ANALYZE`)
}

async function seed() {
  // Guard: this writes hundreds of thousands of rows. Refuse if the target
  // looks like production rather than a disposable environment.
  const [{ n: existing }] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM "User" WHERE id NOT LIKE '${TAG}_%'`
  )
  console.log(`target has ${existing} non-seed users`)
  if (existing > 1000) {
    console.error("REFUSING: target has >1000 real users, this looks like production")
    process.exit(1)
  }

  console.log(`seeding ~${SCALE.users} users, ${SCALE.events} events, ~500k messages...`)

  await db.$executeRawUnsafe(`
    INSERT INTO "User" (id, email, name, "createdAt", "updatedAt", role)
    SELECT '${TAG}_u' || i, '${TAG}_u' || i || '@perf.invalid', 'Perf User ' || i,
           NOW() - (i || ' minutes')::interval, NOW(), 'attendee'
    FROM generate_series(1, ${SCALE.users}) i
    ON CONFLICT DO NOTHING`)
  console.log("  users done")

  await db.$executeRawUnsafe(`
    INSERT INTO profiles (id, name, age, location, bio, interests, photos, goals, looking_for, onboarded, created_at, updated_at)
    SELECT '${TAG}_u' || i, 'Perf User ' || i, 20 + (i % 40), 'City ' || (i % 50),
           'bio text for perf user ' || i, ARRAY['music','tech'], ARRAY[]::text[],
           ARRAY['networking'], ARRAY['friends'], true, NOW(), NOW()
    FROM generate_series(1, ${SCALE.users}) i
    ON CONFLICT DO NOTHING`)
  console.log("  profiles done")

  // Events spread over a year and across a lat/lon grid, so the geo
  // bounding-box query has something realistic to filter.
  await db.$executeRawUnsafe(`
    INSERT INTO events (id, slug, title, description, start_time, end_time, timezone,
                        status, visibility, organizer_id, latitude, longitude, city,
                        current_capacity, check_in_radius, created_at, updated_at)
    SELECT gen_random_uuid(), '${TAG}-e' || i, 'Perf Event ' || i, 'description ' || i,
           NOW() - (i || ' hours')::interval, NOW() - (i || ' hours')::interval + interval '3 hours',
           'UTC', 'published', 'public', '${TAG}_u' || (1 + (i % ${SCALE.users})),
           12.8 + (i % 100) * 0.003, 77.4 + (i % 100) * 0.004, 'City ' || (i % 50),
           0, 30, NOW(), NOW()
    FROM generate_series(1, ${SCALE.events}) i`)
  console.log("  events done")

  await db.$executeRawUnsafe(`
    INSERT INTO chat_groups (id, event_id, type, name, status, member_count, created_at, updated_at)
    SELECT gen_random_uuid(), e.id, 'event', e.title || ' Chat', 'active', 0, NOW(), NOW()
    FROM events e WHERE e.slug LIKE '${TAG}-%'`)
  console.log("  chat groups done")

  // Membership for the first 1000 groups, 20 members each.
  await db.$executeRawUnsafe(`
    INSERT INTO chat_group_members (id, chat_group_id, user_id, role, status, anonymous_name, joined_at, created_at, updated_at)
    SELECT gen_random_uuid(), g.id, '${TAG}_u' || (1 + ((g.rn * 20 + m) % ${SCALE.users})),
           'member', 'active', 'Anon ' || m, NOW(), NOW(), NOW()
    FROM (SELECT id, ROW_NUMBER() OVER () AS rn FROM chat_groups
          WHERE event_id IN (SELECT id FROM events WHERE slug LIKE '${TAG}-%') LIMIT 1000) g,
         generate_series(1, 20) m
    ON CONFLICT DO NOTHING`)
  console.log("  memberships done")

  // The big one: ~500k messages concentrated in 1000 groups, so cursor
  // pagination has real depth to page through.
  await db.$executeRawUnsafe(`
    INSERT INTO chat_messages (id, chat_group_id, user_id, type, content, created_at, updated_at)
    SELECT gen_random_uuid(), g.id, '${TAG}_u' || (1 + ((g.rn + m) % ${SCALE.users})),
           'text', 'perf message ' || m || ' in group ' || g.rn,
           NOW() - (m || ' seconds')::interval, NOW()
    FROM (SELECT id, ROW_NUMBER() OVER () AS rn FROM chat_groups
          WHERE event_id IN (SELECT id FROM events WHERE slug LIKE '${TAG}-%') LIMIT 1000) g,
         generate_series(1, ${SCALE.messagesPerGroup}) m`)
  console.log("  messages done")

  await db.$executeRawUnsafe(`
    INSERT INTO event_check_ins (id, event_id, user_id, status, check_in_time, latitude, longitude, created_at, updated_at)
    SELECT gen_random_uuid(), e.id, '${TAG}_u' || (1 + ((e.rn * 25 + c) % ${SCALE.users})),
           'checked_in', NOW(), 12.9, 77.6, NOW(), NOW()
    FROM (SELECT id, ROW_NUMBER() OVER () AS rn FROM events WHERE slug LIKE '${TAG}-%' LIMIT 2000) e,
         generate_series(1, 25) c
    ON CONFLICT DO NOTHING`)
  console.log("  check-ins done")

  // Plans are chosen from statistics; without this the planner still thinks
  // every table is tiny and the whole exercise measures nothing.
  console.log("running ANALYZE so the planner sees the new statistics...")
  await db.$executeRawUnsafe(`ANALYZE`)
}

async function main() {
  if (process.argv.includes("--clean")) {
    await clean()
  } else {
    await seed()
  }
  const rows = await db.$queryRawUnsafe<{ relname: string; rows: number }[]>(`
    SELECT relname, n_live_tup::int AS rows FROM pg_stat_user_tables
    WHERE n_live_tup > 0 ORDER BY n_live_tup DESC LIMIT 6`)
  console.log("\nrow counts now:")
  for (const r of rows) console.log(`  ${r.relname.padEnd(22)} ${r.rows}`)
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
  .finally(() => db.$disconnect())
