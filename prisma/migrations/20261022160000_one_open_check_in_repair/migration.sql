-- One open check-in per person (SCRUM-705), part 1 of 2: repair the rows that
-- would stop the index in the next migration from being built.
--
-- "One room at a time" was app code only: the switch (checkOutOfOtherEvents)
-- and the new check-in were two statements with nothing beneath them, so two
-- doors at once could both leave a row `checked_in`; and the switch skipped
-- the person's earlier days of the same event, so day 1 stayed open beside
-- day 2 until the sweeper got there. Either leaves a person with two open rows.
--
-- Kept: the newest open row per person (check-in time, then creation). Closed:
-- every other, at now, with their open presence sessions. `sweeper` is the
-- honest source: nobody saw them leave, this pass inferred it.
--
-- Wrapped: `migrate deploy` applies statement by statement, so a failure part-way
-- would leave the sessions closed and the check-ins open and block every later
-- deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE "stale_open_check_ins" ON COMMIT DROP AS
SELECT "id", "occurrence_id", "user_id"
  FROM (
    SELECT "id", "occurrence_id", "user_id",
           row_number() OVER (
             PARTITION BY "user_id"
             ORDER BY "check_in_time" DESC NULLS LAST, "created_at" DESC, "id" DESC
           ) AS "rank"
      FROM "event_check_ins"
     WHERE "status" = 'checked_in'
  ) AS "ranked"
 WHERE "rank" > 1;

UPDATE "presence_sessions" AS s
   SET "departed_at" = now(), "departed_source" = 'sweeper', "updated_at" = now()
  FROM "stale_open_check_ins" AS c
 WHERE s."occurrence_id" = c."occurrence_id"
   AND s."user_id" = c."user_id"
   AND s."departed_at" IS NULL;

UPDATE "event_check_ins"
   SET "status" = 'checked_out', "check_out_time" = now(), "updated_at" = now()
 WHERE "id" IN (SELECT "id" FROM "stale_open_check_ins");

COMMIT;
