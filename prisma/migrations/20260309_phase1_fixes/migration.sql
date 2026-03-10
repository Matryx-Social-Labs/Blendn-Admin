-- Phase 1 fixes: data integrity & security

-- Fix #32: Remove legacy push token columns from profiles.
-- All push tokens now live exclusively in the push_tokens table.
ALTER TABLE "profiles" DROP COLUMN IF EXISTS "push_token";
ALTER TABLE "profiles" DROP COLUMN IF EXISTS "push_platform";

-- Fix #26: Sync User.name from profiles.name on every profile update.
-- profiles.name is the canonical source of truth going forward.
-- Backfill: copy profiles.name → User.name for all existing rows where they differ.
UPDATE "User" u
SET    name = p.name
FROM   profiles p
WHERE  p.id = u.id
  AND  p.name IS NOT NULL
  AND  (u.name IS NULL OR u.name <> p.name);

-- Fix #17 + #12: Add a check constraint to prevent current_capacity going negative.
ALTER TABLE "events"
  ADD CONSTRAINT events_capacity_non_negative
  CHECK (current_capacity >= 0);

-- Fix #35: Wire up the 'cancelled' enum value — ensure the constraint exists.
-- (No DDL change needed; the enum value exists, it just wasn't used. Now referenced in event cancellation flow.)
