-- "Open on Blendn" (D-13, step 18): a claimed venue's owner may take it out of
-- the app's Places list and home map. Its events still show; nothing else
-- changes. True for every existing row, so nothing moves on deploy.
--
-- An unclaimed venue is always listed whatever this says: the rule lives in
-- the reader (`openOnBlendnWhere`, lib/venue-visibility.ts), so a claim that is
-- revoked or transferred cannot leave a place hidden that nobody owns.
--
-- Additive, NOT NULL with a constant default: a metadata-only change on
-- Postgres 11+, no table rewrite. Rolling back is a NEW forward migration that
-- drops the column (never SQL by hand against staging or production); a
-- rollback of the CODE alone is safe, since older code reads no such column.
--
-- `prisma migrate deploy` sends a file statement by statement, outside any
-- transaction, so the file is its own transaction and `lock_timeout` holds.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "venues" ADD COLUMN "open_on_blendn" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
