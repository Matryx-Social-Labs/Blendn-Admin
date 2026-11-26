-- A pending promotion to admin (SCRUM-1240, launch gate 10): who asked and when. A second admin confirms
-- within 24 h (app/dashboard/users/actions.ts). Additive: two nullable columns with no default, so Postgres
-- changes the catalogue only, rewrites no row and holds the ACCESS EXCLUSIVE lock for milliseconds; the
-- lock_timeout makes the deploy give up rather than queue behind a long query on "User".
-- No foreign key on admin_requested_by: a requester who is later erased must block nothing, and the
-- audit row (user.admin_promotion_requested) is the record. No index: read only by the row's own id.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "User" ADD COLUMN "admin_requested_by" TEXT, ADD COLUMN "admin_requested_at" TIMESTAMPTZ(6);

COMMIT;
