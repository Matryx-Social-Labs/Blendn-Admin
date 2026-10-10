-- Audit rows belong to an organisation (step 18 security review, M3).
--
-- An organisation's owners and admins read their log as "rows written by our
-- members". A member of two organisations put their work for the other one in
-- front of this one, and a member who left took their history with them. A
-- row now records the organisation whose data the action changed — `org_id`,
-- written with the row by lib/audit-log.ts, whoever acted — and the log reads
-- by it. Null: the platform's alone. The rows from before are given theirs by
-- the next migration, in its own transaction, so this one holds its lock only
-- for the column and the index.
--
-- Additive: a nullable column with no default is a catalogue change, and the
-- index build takes a SHARE lock for its duration on a table of thousands of
-- rows. Rolling back is a NEW forward migration dropping the index and the
-- column; a rollback of the CODE alone is safe, since older code reads no such
-- column. The file is its own transaction (`prisma migrate deploy` sends
-- statements one at a time otherwise).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_logs" ADD COLUMN "org_id" UUID;

CREATE INDEX "audit_logs_org_id_created_at_idx" ON "audit_logs"("org_id", "created_at");

COMMIT;
