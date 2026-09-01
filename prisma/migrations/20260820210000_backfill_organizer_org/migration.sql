-- Backfill `events.organizer_org_id` from the creator's organisation.
--
-- Nothing in production ever wrote this column. Only two seed scripts did, so
-- every event created through the product has it null -- and `lib/rbac.ts` is
-- built on it. `eventPermissions` could never match the organiser branch, which
-- is why an organiser could not edit the event they had just created, and why
-- `GET /api/events` needed a legacy `organizer_id` clause to return anything at
-- all.
--
-- The rule here is deliberately the same one `lib/event-ownership.ts` applies at
-- runtime: **oldest membership wins**. If the two disagreed, an event written
-- today and an event backfilled from yesterday would land on different
-- organisations for the same creator, and which one they got would decide who
-- else could edit it.
--
-- `DISTINCT ON` needs its leading `ORDER BY` column to match the partition, so
-- the inner ordering is (user_id, created_at) and the outer pick is the first
-- row per user -- their earliest organisation.
--
-- Only touches rows that are still null: re-running changes nothing, and an
-- event whose org was set deliberately is never rewritten.
UPDATE "events" e
SET "organizer_org_id" = m."org_id"
FROM (
  SELECT DISTINCT ON ("user_id") "user_id", "org_id"
  FROM "organisation_members"
  ORDER BY "user_id", "created_at" ASC
) m
WHERE e."organizer_id" = m."user_id"
  AND e."organizer_org_id" IS NULL;

-- Events whose creator belongs to no organisation are deliberately left null.
-- There is no correct organisation to invent for them, and `app_admin`-created
-- events legitimately have none: `eventPermissions` short-circuits an admin
-- before it looks at ownership. The legacy `organizer_id` clause in
-- `GET /api/events` stays for exactly these until curation gives the platform
-- an organisation of its own.
