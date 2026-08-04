/**
 * Copy one database into another, table by table, in foreign-key order.
 *
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... npx tsx scripts/copy-db.ts
 *
 * Used to give staging real data shapes to validate dependency upgrades
 * against — the unit suite mocks the database, so an upgrade that breaks a
 * query on real data (nulls, long text, unicode, enum values that only occur in
 * practice, deep pagination) has nowhere else to surface before production.
 *
 * Goes through Prisma rather than pg_dump so enum, JSON, array and timestamptz
 * columns round-trip using the same type mapping the app itself uses.
 *
 * Refuses to run unless the target is empty. Copying INTO a database with rows
 * is never what you want here, and getting the direction backwards would be
 * unrecoverable.
 */
import { PrismaClient } from "@prisma/client"

const SOURCE = process.env.SOURCE_DATABASE_URL
const TARGET = process.env.TARGET_DATABASE_URL

if (!SOURCE || !TARGET) {
  console.error("SOURCE_DATABASE_URL and TARGET_DATABASE_URL are both required")
  process.exit(1)
}
if (SOURCE === TARGET) {
  console.error("SOURCE and TARGET are the same database")
  process.exit(1)
}

const src = new PrismaClient({ datasources: { db: { url: SOURCE } } })
const dst = new PrismaClient({ datasources: { db: { url: TARGET } } })

/**
 * Parents before children. A row whose foreign key has not been inserted yet
 * fails, so this order is the whole contract of the script.
 */
const ORDER = [
  "user",
  "account",
  "session",
  "verificationToken",
  "profiles",
  "categories",
  "events",
  "event_details",
  "event_categories",
  "event_media",
  "recurring_events",
  "chat_groups",
  "chat_group_members",
  "chat_messages",
  "message_reactions",
  "event_check_ins",
  "event_rsvps",
  "event_favorites",
  "event_ratings",
  "event_reports",
  "user_reports",
  "message_reports",
  "mobile_refresh_tokens",
  "user_interests",
  "user_oauth_accounts",
  "push_tokens",
  "private_conversations",
  "private_messages",
  "event_sponsored_messages",
  "event_announcements",
  "audit_logs",
  "blocked_users",
  "message_requests",
  "moderation_flags",
] as const

const BATCH = 500

async function main() {
  // Guard: the target must be empty. Checked on User because every meaningful
  // row in this schema hangs off it.
  const existing = await (dst as never as Record<string, { count: () => Promise<number> }>)[
    "user"
  ].count()
  if (existing > 0) {
    console.error(`REFUSING: target already has ${existing} users. Expected an empty database.`)
    process.exit(1)
  }

  let total = 0
  for (const model of ORDER) {
    const s = (src as never as Record<string, { findMany: (a?: unknown) => Promise<unknown[]> }>)[model]
    const d = (dst as never as Record<string, { createMany: (a: unknown) => Promise<{ count: number }> }>)[model]
    if (!s || !d) {
      console.log(`  ${model}: not on the client, skipped`)
      continue
    }

    const rows = await s.findMany()
    if (rows.length === 0) {
      console.log(`  ${model}: 0`)
      continue
    }

    let written = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      // skipDuplicates so a re-run after a partial failure is safe.
      const res = await d.createMany({ data: chunk, skipDuplicates: true })
      written += res.count
    }
    total += written
    console.log(`  ${model}: ${written}${written !== rows.length ? ` (of ${rows.length}, dupes skipped)` : ""}`)
  }
  console.log(`\ncopied ${total} rows`)
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
  .finally(async () => {
    await src.$disconnect()
    await dst.$disconnect()
  })
