-- Server gaps the rebuilt client screens wait on. Every column is either
-- nullable with no default, or NOT NULL with a constant default: on Postgres 11+
-- neither rewrites the table, so each is a catalogue change under a brief lock.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- "Changed while you're going": when the time, the venue or the status moved,
-- and what they were before (lib/event-change.ts). Null for every event until
-- one changes.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "changed_at" TIMESTAMPTZ(6);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "changed_from" JSONB;

-- "Your photo didn't meet the photo rules": when a profile photo was pulled and
-- whether it was the main one. Null on rows pulled before this, which are never
-- listed to their owner.
ALTER TABLE "photo_checks" ADD COLUMN IF NOT EXISTS "pulled_at" TIMESTAMPTZ(6);
ALTER TABLE "photo_checks" ADD COLUMN IF NOT EXISTS "pulled_was_main" BOOLEAN;

-- Per-kind push switches under the master `push_enabled`. Default on, as the
-- master is.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "push_people" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "push_crew" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "push_later" BOOLEAN NOT NULL DEFAULT true;

-- Which Android channel set the install created; null is every build before it.
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "channel_set" SMALLINT;

COMMIT;
