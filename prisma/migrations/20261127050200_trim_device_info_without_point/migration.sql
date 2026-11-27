-- Once: the phone details of check-ins that no longer hold a point (SCRUM-1230, D-029). The old Go Live sweep nulled a
-- window's latitude and longitude three days after it ended but left `device_info` whole, and `forgetCheckInPoints`
-- (lib/presence-sweeper.ts) only reaches rows that still hold a point, so these would keep the phone model and app
-- version for good. Cut to the same keys it keeps (`KEPT_DEVICE_INFO_KEYS`): GPS accuracy, the platform and the seed
-- scripts' test-data markers; NULL when none is left or it is not a JSON object. No new row can need this: the app
-- always sends a point with its device details (`checkinSchema`), and account deletion nulls both.
--
-- In a transaction, as every migration that can be, with lock_timeout so a row a check-in holds fails the deploy fast
-- rather than stalling it (__tests__/migration-tx.test.ts). Data only: no column or table changes. Staging had 0 such rows on
-- 2026-11-27; production never ran the old sweep.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE "event_check_ins"
   SET "device_info" = CASE WHEN jsonb_typeof("device_info") = 'object' THEN
         (SELECT jsonb_object_agg(key, value) FROM jsonb_each("device_info") WHERE key = ANY(ARRAY['gpsAccuracy', 'platform', 'source', 'qaScale']))
       END
 WHERE "latitude" IS NULL AND "longitude" IS NULL AND "device_info" IS NOT NULL
   AND CASE WHEN jsonb_typeof("device_info") = 'object'
            THEN "device_info" - ARRAY['gpsAccuracy', 'platform', 'source', 'qaScale'] <> '{}'::jsonb
            ELSE true END;

COMMIT;
