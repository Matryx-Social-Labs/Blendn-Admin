/**
 * Backfill script: Assigns anonymous names to existing chat_group_members
 * rows where anonymous_name IS NULL.
 *
 * Usage: npx tsx scripts/backfill-anonymous-names.ts
 */

import { db } from "../lib/db"
import { generateUniqueAnonymousName } from "../lib/anonymous-names"

async function main() {
  // Get all distinct chat groups that have members without anonymous names
  const groups = await db.chat_group_members.findMany({
    where: { anonymous_name: null },
    select: { chat_group_id: true },
    distinct: ["chat_group_id"],
  })

  console.log(`Found ${groups.length} groups with members needing anonymous names`)

  let totalUpdated = 0

  for (const { chat_group_id } of groups) {
    const members = await db.chat_group_members.findMany({
      where: {
        chat_group_id,
        anonymous_name: null,
      },
      select: { id: true },
    })

    console.log(`  Group ${chat_group_id}: ${members.length} members to backfill`)

    for (const member of members) {
      const anonName = await generateUniqueAnonymousName(chat_group_id)
      await db.chat_group_members.update({
        where: { id: member.id },
        data: { anonymous_name: anonName },
      })
      totalUpdated++
    }
  }

  console.log(`Done! Updated ${totalUpdated} members total.`)
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
