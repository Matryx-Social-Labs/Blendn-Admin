-- Backfill the hosts the first pass missed.
--
-- 20260805_organisations created an organisation for every user whose *role*
-- was organizer or venue_owner. That was the wrong rule: it should follow the
-- data, not the role. On staging it left 5 events with no organisation — 2
-- created by an app_admin and 3 by a user who is now an attendee, presumably
-- having been demoted after creating them.
--
-- An event with no organisation is not a broken screen; it is a row that no
-- non-admin can ever reach, and one that cannot have a colleague added to it.
-- Anyone who owns an event or a venue gets an organisation, whatever role they
-- hold today.
--
-- Same derived id as the first pass, so a user already handled is a no-op
-- rather than a second organisation.

INSERT INTO "organisations" ("id", "kind", "display_name", "status", "verified_at")
SELECT DISTINCT
       uuid_in(md5('blendn-org:' || u."id")::cstring),
       'individual'::organisation_kind,
       COALESCE(NULLIF(u."name", ''), split_part(u."email", '@', 1)),
       'verified'::organisation_status,
       CURRENT_TIMESTAMP
FROM "User" u
WHERE EXISTS (SELECT 1 FROM "events" e WHERE e."organizer_id" = u."id")
   OR EXISTS (SELECT 1 FROM "venues" v WHERE v."owner_id" = u."id")
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "organisation_members" ("id", "org_id", "user_id", "role", "is_primary_contact")
SELECT DISTINCT
       gen_random_uuid(),
       uuid_in(md5('blendn-org:' || u."id")::cstring),
       u."id",
       'owner'::org_role,
       true
FROM "User" u
WHERE EXISTS (SELECT 1 FROM "events" e WHERE e."organizer_id" = u."id")
   OR EXISTS (SELECT 1 FROM "venues" v WHERE v."owner_id" = u."id")
ON CONFLICT ("org_id", "user_id") DO NOTHING;

UPDATE "events" e
SET "organizer_org_id" = m."org_id"
FROM "organisation_members" m
WHERE m."user_id" = e."organizer_id" AND e."organizer_org_id" IS NULL;

UPDATE "venues" v
SET "owner_org_id" = m."org_id"
FROM "organisation_members" m
WHERE m."user_id" = v."owner_id" AND v."owner_org_id" IS NULL;
