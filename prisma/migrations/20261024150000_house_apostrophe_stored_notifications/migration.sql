-- Bell rows written before #751 keep their typewriter apostrophe ("It's a
-- Blend", "You're invited to a crew", "Open Blend'n to see") for up to 90 days
-- (unread retention), so the app still showed it after the code was fixed.
-- Put the house apostrophe into those rows.
--
-- Only the kinds whose title and body are our fixed copy. An event's name is in
-- the title of event_update / rating_request / announcement rows, and a person
-- wrote that: it is not ours to retype. waitlist_promoted: its title only (its
-- body carries the event's name).
--
-- `prisma migrate deploy` runs a file statement by statement, outside any
-- transaction, so this file is its own: SET LOCAL applies, and a failure applies
-- nothing. A few thousand rows at most (90 days of fixed-copy kinds), updated in
-- place with no rewrite of indexes it does not touch. Idempotent: a second run
-- matches nothing. There is no way back and none is wanted.
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE "notifications"
SET "title" = replace("title", '''', '’'),
    "body" = replace("body", '''', '’')
WHERE "kind"::text IN ('friend_request', 'friend_accepted', 'crew_invite', 'blend', 'match')
  AND ("title" LIKE '%''%' OR "body" LIKE '%''%');
UPDATE "notifications"
SET "title" = replace("title", '''', '’')
WHERE "kind"::text = 'waitlist_promoted' AND "title" LIKE '%''%';
COMMIT;
