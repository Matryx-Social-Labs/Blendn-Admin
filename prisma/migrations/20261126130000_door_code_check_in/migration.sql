-- The door code (gate 13, SCRUM-1316; design/02a SPEC §3). Additive only: no drop, rename or rewrite.
-- How each check-in was made, when a host's door code was paused, and five new refusal reasons.
-- lock-ok: every statement is metadata-only (a constant DEFAULT on NOT NULL is not a rewrite on Postgres 11+); the lock rule reads "CHECK" in the type name check_in_method.
-- Wrapped, because `migrate deploy` is not transactional (memory note). `ADD VALUE` may run inside a
-- transaction on Postgres 12+; nothing in this file uses the new values, so none is read before COMMIT.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "check_in_method" AS ENUM ('gps', 'door_code', 'review');

-- A NOT NULL column with a constant default is metadata-only on Postgres 11+: no table rewrite,
-- the ACCESS EXCLUSIVE lock is held for the catalogue change only. Every existing row reads 'gps'.
ALTER TABLE "event_check_ins" ADD COLUMN "method" "check_in_method" NOT NULL DEFAULT 'gps';

-- Nullable, no default: metadata-only. In force only from the current occurrence's doors, for 10 minutes.
ALTER TABLE "events" ADD COLUMN "door_code_paused_at" TIMESTAMPTZ(6);

ALTER TYPE "refusal_reason" ADD VALUE 'weak_fix';
ALTER TYPE "refusal_reason" ADD VALUE 'door_code_wrong';
ALTER TYPE "refusal_reason" ADD VALUE 'door_code_far';
ALTER TYPE "refusal_reason" ADD VALUE 'door_code_locked';
ALTER TYPE "refusal_reason" ADD VALUE 'door_code_paused';

COMMIT;
