-- SCRUM-198: the client app is for attendees. Organisers, venue owners,
-- sponsors and admins use the dashboard, and from this deploy the mobile
-- sign-in, Google, Apple and refresh routes refuse them. A staff session
-- that already exists would otherwise live until its refresh token expired
-- (30 days); end them now so the refusal applies within one access-token
-- lifetime (15 minutes) everywhere this migration runs.
UPDATE "mobile_refresh_tokens" t
SET "revoked_at" = now()
FROM "User" u
WHERE u."id" = t."user_id"
  AND u."role" <> 'attendee'
  AND t."revoked_at" IS NULL;
