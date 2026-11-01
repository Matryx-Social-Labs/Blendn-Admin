-- SCRUM-984: the dashboard role an attendee accepting an invite comes out as, fixed when it is sent.
BEGIN;
ALTER TABLE "organisation_invites" ADD COLUMN IF NOT EXISTS "grants_role" "user_role";
COMMIT;
