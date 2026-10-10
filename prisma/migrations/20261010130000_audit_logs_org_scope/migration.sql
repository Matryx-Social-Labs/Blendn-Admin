-- Audit rows scoped to an organisation (step 18 security review, M3).
--
-- An organisation's owners and admins read their log as "rows written by our
-- members". A member of two organisations, or one who joined last week, put
-- their other organisation's actions — and their own past — in front of this
-- one. From now on a row records the organisation it belongs to: `org_id`,
-- written when the actor is a member of the organisation that owns the row's
-- resource (lib/audit-log.ts), and the log reads by it.
--
-- `pre_org_scope` marks the rows written before this: true for every existing
-- row (the column's value when added), false for every row after (the default
-- changes in the same transaction). Those old rows keep the actor rule, now
-- bounded to rows written after the actor joined (lib/audit-actions.ts).
--
-- Additive and metadata-only on Postgres 11+ (a constant default, no rewrite);
-- the index build takes a SHARE lock for its duration on a table of thousands
-- of rows. Rolling back is a NEW forward migration dropping both columns and
-- the index; a rollback of the CODE alone is safe, since older code reads
-- neither column. The file is its own transaction (`prisma migrate deploy`
-- sends statements one at a time otherwise).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_logs" ADD COLUMN "org_id" UUID;
ALTER TABLE "audit_logs" ADD COLUMN "pre_org_scope" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "audit_logs" ALTER COLUMN "pre_org_scope" SET DEFAULT false;

CREATE INDEX "audit_logs_org_id_created_at_idx" ON "audit_logs"("org_id", "created_at");

COMMIT;
