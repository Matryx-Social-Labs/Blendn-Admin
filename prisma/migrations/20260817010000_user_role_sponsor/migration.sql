-- The `sponsor` dashboard role.
--
-- Alone in its own migration, deliberately. Adding a value to an enum is not
-- transactional in Postgres before 12 and cannot be used in the same
-- transaction that adds it, so mixing this with the tables that reference it
-- risks a migration that half-applies. `railway.json` runs `prisma migrate
-- deploy` as a preDeployCommand, so a failure here does not just fail a
-- migration — it stops the service coming back.
--
-- `IF NOT EXISTS` matches the precedent set by 20260807_waitlist and makes the
-- statement safe to re-run either way.
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'sponsor';

-- Polls are a message kind. Same reasoning, same file: enum values go in
-- alone, before anything references them.
ALTER TYPE "message_type" ADD VALUE IF NOT EXISTS 'poll';
