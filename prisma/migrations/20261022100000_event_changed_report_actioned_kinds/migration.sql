-- Two notification kinds (Flow 3 · 3.1, Flow 9): the event you are going to
-- changed, and a report you filed was acted on. Recorded in the bell like every
-- other kind (`lib/push-notifications.ts`).
--
-- Its own migration because Postgres will not use an enum value in the
-- transaction that added it. Rolling back: a value cannot be dropped from an
-- enum in place; a NEW forward migration recreates the type without it, once
-- no notification row uses it.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'event_changed';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'report_actioned';

COMMIT;
