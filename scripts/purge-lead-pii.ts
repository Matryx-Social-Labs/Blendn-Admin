import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { LEAD_PII_RETENTION_DAYS } from "../lib/leads"

/**
 * Drop the personal fields from old leads.
 *
 * `ip` and `user_agent` are personal data with no operational value after the
 * lead is worked — they exist to spot an abuse wave, and an abuse wave a year
 * old is history. Written now rather than when someone asks, because "we will
 * add retention later" is how a table quietly becomes a liability.
 *
 * The lead itself is kept: status, email and notes are the record of a business
 * conversation. Only the tracking fields go.
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/purge-lead-pii.ts           # dry run
 *   DATABASE_URL=... npx tsx scripts/purge-lead-pii.ts --apply
 */
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

async function main() {
  const apply = process.argv.includes("--apply")
  const cutoff = new Date(Date.now() - LEAD_PII_RETENTION_DAYS * 24 * 3_600_000)

  const where = {
    created_at: { lt: cutoff },
    OR: [{ ip: { not: null } }, { user_agent: { not: null } }],
  }

  const count = await db.leads.count({ where })
  console.log(
    `${count} lead(s) older than ${LEAD_PII_RETENTION_DAYS} days still carry ip/user_agent`
  )
  if (count === 0 || !apply) {
    console.log(apply ? "Nothing to do." : "Dry run. Re-run with --apply to clear them.")
    return
  }

  const { count: cleared } = await db.leads.updateMany({
    where,
    data: { ip: null, user_agent: null },
  })
  console.log(`Cleared ${cleared}.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
