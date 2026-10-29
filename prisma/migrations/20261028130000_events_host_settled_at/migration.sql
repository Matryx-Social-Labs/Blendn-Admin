-- When a night's host-side lists closed (SCRUM-887). Written once by the server
-- (lib/attendee-counts.ts `hostSettledAt`), never by a host, never cleared.
-- Nullable, no default: adding it rewrites nothing and takes the lock briefly.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "host_settled_at" TIMESTAMPTZ(6);
COMMIT;
