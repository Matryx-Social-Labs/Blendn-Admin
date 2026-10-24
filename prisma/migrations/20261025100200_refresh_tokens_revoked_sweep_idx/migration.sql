-- `cleanupExpiredTokens` (every five minutes) is `expires_at < now OR (revoked_at <
-- cutoff AND revoked_reason IS NULL)`. The first half has `expires_at` indexed; the
-- second had nothing, which made the OR a scan of the whole table (500k rows: every
-- block read to find a few dozen). With this partial index (a row that is still
-- revoked-without-a-reason and so due, and no other) the two halves are a BitmapOr.
-- It cannot be written in schema.prisma: partial indexes live in migration SQL.
--
-- CONCURRENTLY: ONE statement, no BEGIN/COMMIT (`__tests__/migration-tx.test.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "mobile_refresh_tokens_revoked_sweep_idx" ON "mobile_refresh_tokens" ("revoked_at") WHERE "revoked_reason" IS NULL AND "revoked_at" IS NOT NULL
