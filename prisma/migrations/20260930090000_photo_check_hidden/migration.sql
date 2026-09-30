-- A profile photo moderation pulled is recorded as pulled (SCRUM-479).
--
-- A hide verdict and a pass both wrote `checked = true`, so nothing could tell
-- a removed photo from an approved one: the profile PUT wrote a pulled URL back
-- when a save re-sent it, and account deletion could not keep the removed ones
-- for their 180 days (docs/RETENTION.md, r.3(1)(g)). Earlier verdicts are not
-- recoverable from the row and stay false.
ALTER TABLE "photo_checks" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
