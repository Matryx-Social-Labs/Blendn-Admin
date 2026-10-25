-- App Review aid: an event a REVIEW_ACCOUNT_IDS account may check in to
-- from anywhere (lib/review-accounts.ts). False for every existing row.
--
-- ADD COLUMN with a constant DEFAULT is catalogue-only on Postgres 11+ (no
-- table rewrite); lock_timeout bounds the instant of ACCESS EXCLUSIVE it needs
-- behind a long transaction. `prisma migrate deploy` sends statements one by
-- one outside any transaction, so this file is its own. Rolling back is a NEW
-- forward migration dropping the column.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "events" ADD COLUMN "review_demo" BOOLEAN NOT NULL DEFAULT false;
COMMIT;
