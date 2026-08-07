import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"

/**
 * Shared setup for integration tests.
 *
 * These execute real SQL. The unit suite mocks `@/lib/db`, so nothing else in
 * the repo would notice a Prisma upgrade changing query semantics — that is the
 * entire reason this directory exists.
 */
/**
 * The pool is created explicitly rather than letting the adapter own it,
 * because `prisma.$disconnect()` does NOT close a pool the adapter created —
 * jest then hangs after the run with open handles, which in CI is a job that
 * never finishes rather than a test that fails. `closeDb()` ends both.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db = new PrismaClient({ adapter: new PrismaPg(pool) })

export async function closeDb() {
  await db.$disconnect()
  await pool.end()
}

/** Namespace every fixture so a failed run can never collide with the next. */
export const testId = (label: string) =>
  `itest_${label}_${Math.random().toString(36).slice(2, 10)}`

/**
 * Delete in FK-dependency order, children first. Truncating the whole schema
 * would race the other suites, since jest shares one database here.
 */
export async function cleanup(userIds: string[], eventIds: string[]) {
  if (eventIds.length) {
    await db.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: eventIds } } } })
    await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: eventIds } } } })
    await db.chat_groups.deleteMany({ where: { event_id: { in: eventIds } } })
    await db.event_check_ins.deleteMany({ where: { event_id: { in: eventIds } } })
    await db.event_rsvps.deleteMany({ where: { event_id: { in: eventIds } } })
    await db.events.deleteMany({ where: { id: { in: eventIds } } })
  }
  if (userIds.length) {
    await db.private_messages.deleteMany({ where: { sender_id: { in: userIds } } })
    await db.private_conversations.deleteMany({
      where: { OR: [{ user1_id: { in: userIds } }, { user2_id: { in: userIds } }] },
    })
    await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: userIds } } })
    await db.profiles.deleteMany({ where: { id: { in: userIds } } })
    await db.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

export async function makeUser(label: string, role: "attendee" | "organizer" | "app_admin" = "attendee") {
  const id = testId(label)
  await db.user.create({
    data: { id, email: `${id}@itest.invalid`, name: `Test ${label}`, role },
  })
  return id
}

export async function makeEvent(
  organizerId: string,
  overrides: Partial<{ visibility: "public" | "private" | "unlisted"; deleted_at: Date | null }> = {}
) {
  const slug = testId("evt")
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug,
      title: `Test ${slug}`,
      description: "integration fixture",
      start_time: new Date(now - 60 * 60 * 1000),
      end_time: new Date(now + 60 * 60 * 1000),
      timezone: "UTC",
      status: "published",
      organizer_id: organizerId,
      visibility: overrides.visibility ?? "public",
      deleted_at: overrides.deleted_at ?? null,
    },
  })

  // Every event has at least one occurrence — the API guarantees it, and
  // check-ins are NOT NULL on it. A fixture without one would be a shape that
  // cannot exist in production.
  await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  return event.id
}

/** The (single) occurrence a fixture event was created with. */
export async function occurrenceOf(eventId: string): Promise<string> {
  const o = await db.event_occurrences.findFirst({
    where: { event_id: eventId },
    select: { id: true },
  })
  if (!o) throw new Error(`fixture event ${eventId} has no occurrence`)
  return o.id
}
