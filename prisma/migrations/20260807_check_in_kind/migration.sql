-- Staff and guests are different numbers.
--
-- Organisers and venue staff check in through the same button as everyone else
-- — the client app has no notion of roles and is not gaining one. The server
-- derives this from organisation membership at check-in time.
--
-- Stored rather than computed on read because membership changes: someone who
-- leaves the organisation next month should not retroactively become a guest at
-- last month's event. The row records what they were then.

CREATE TYPE "check_in_kind" AS ENUM ('attendee', 'staff');

ALTER TABLE "event_check_ins"
  ADD COLUMN "kind" "check_in_kind" NOT NULL DEFAULT 'attendee';

-- Backfill: a check-in belongs to staff if that user was, at any point, a
-- member of the organisation running the event or owning its venue. Membership
-- today is the best available proxy for membership then — there is no history
-- table — and it is right for every row currently in the database.
UPDATE "event_check_ins" ci
SET "kind" = 'staff'
FROM "events" e
LEFT JOIN "venues" v ON v."id" = e."venue_id"
WHERE ci."event_id" = e."id"
  AND EXISTS (
    SELECT 1 FROM "organisation_members" m
    WHERE m."user_id" = ci."user_id"
      AND (m."org_id" = e."organizer_org_id" OR m."org_id" = v."owner_org_id")
  );

CREATE INDEX "event_check_ins_event_id_kind_idx" ON "event_check_ins" ("event_id", "kind");
