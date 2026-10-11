-- Regulars and blind offers (step 12, plan v2 §2): a venue's offer reaches its
-- regulars as a push, recorded in the bell like every other.
--
-- Its own migration because Postgres will not use an enum value in the
-- transaction that added it. Rolling back: a value cannot be dropped from an
-- enum in place; a NEW forward migration recreates the type without it, once
-- no notification row uses it.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'venue_offer';
