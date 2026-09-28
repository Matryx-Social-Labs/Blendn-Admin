// Relative, not `@/`: reachable from `server.ts` through the retention sweeper,
// and `build:server` cannot resolve the alias (server-import-boundary.test.ts).
import { db } from "./db"

/**
 * India's IT (Intermediary Guidelines) Rules 2021, r.3(1)(h): registration
 * information is kept for 180 days after the registration is cancelled. After
 * that the DPDP Act 2023 says it must go. Not configurable, for the reason the
 * notification windows are not: a period that can be set will be set wrong.
 */
export const REGISTRATION_RETENTION_DAYS = 180

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Copy what the person registered with into `deleted_account_records`.
 *
 * Returns the unawaited statement so the deletion route can put it FIRST in
 * its `$transaction` batch: it reads the current values before anything is
 * scrubbed, and it commits or rolls back with the scrub — a failed deletion
 * leaves no copy, a successful one always has one.
 *
 * `INSERT … SELECT` rather than read-then-create, so the copy is of the row as
 * it stands inside the transaction, not as it stood a round-trip earlier.
 *
 * `deletedAt IS NULL`: an account already erased has already been copied, and
 * a second copy would be of the anonymised husk.
 *
 * The sign-up method: a password means they registered with email (the mobile
 * app never sets one on an OAuth account); otherwise the first provider linked.
 * ponytail: an unverified email sign-up that later linked Google had its
 * password cleared (lib/mobile-auth.ts) and reads as 'google'. Distinguishing it
 * needs the link time compared with the sign-up time.
 */
export function recordDeletedAccount(userId: string, deletedAt: Date) {
  const purgeAfter = new Date(deletedAt.getTime() + REGISTRATION_RETENTION_DAYS * DAY_MS)
  return db.$executeRaw`
    INSERT INTO deleted_account_records
      (id, user_id, name, email, phone, date_of_birth, account_created_at,
       deleted_at, sign_up_method, purge_after)
    SELECT
      gen_random_uuid(), u.id, COALESCE(p.name, u.name), u.email, p.phone,
      p.date_of_birth, u."createdAt", ${deletedAt}::timestamptz,
      CASE
        WHEN u.password IS NOT NULL THEN 'email'
        ELSE COALESCE(
          (SELECT o.provider FROM user_oauth_accounts o
            WHERE o.user_id = u.id AND o.provider IN ('google', 'apple')
            ORDER BY o.created_at LIMIT 1),
          -- No link time on NextAuth's Account; a cuid id starts with one.
          (SELECT a.provider FROM "Account" a
            WHERE a."userId" = u.id AND a.provider IN ('google', 'apple')
            ORDER BY a.id LIMIT 1),
          'email')
      END,
      ${purgeAfter}::timestamptz
    FROM "User" u
    LEFT JOIN profiles p ON p.id = u.id
    WHERE u.id = ${userId} AND u."deletedAt" IS NULL`
}

/**
 * Hard-delete every record past its purge date. Returns how many went.
 *
 * Idempotent: the predicate is an absolute timestamp, so a second pass deletes
 * nothing. Unbatched because the table grows by one row per deleted account.
 */
export async function purgeDeletedAccountRecords(now: Date = new Date()): Promise<number> {
  const { count } = await db.deleted_account_records.deleteMany({
    where: { purge_after: { lt: now } },
  })
  return count
}
