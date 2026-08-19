import { db } from "./db"

/**
 * Reclaim upload grants nobody redeemed.
 *
 * Unconsumed and expired only. A grant that WAS used keeps its row: it is the
 * record of where a live creative's bytes came from, and deleting it would leave
 * `media_version_id` on the creative with nothing to explain it.
 *
 * This only forgets the permission — it does not touch storage. An orphaned
 * object costs pennies; deleting one still referenced by an approved creative
 * costs a sponsor their campaign.
 *
 * Lives here rather than in `lib/upload-grant-actions.ts` because it takes no
 * actor and is called by the scheduler, which runs inside `server.ts` — and that
 * graph is compiled by `tsc`, so anything it reaches must avoid the `@/` alias
 * and must not drag NextAuth or the S3 client along with it.
 */
export async function sweepExpiredGrants(now: Date = new Date()): Promise<number> {
  const { count } = await db.upload_grants.deleteMany({
    where: { consumed_at: null, expires_at: { lt: now } },
  })
  return count
}
