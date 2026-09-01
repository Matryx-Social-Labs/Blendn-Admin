-- A mute needs to record who applied it, for the same reason a ban does.
--
-- `checkAndAutoUnmute` clears any `muted` status from a member with fewer than
-- three auto-hide flags in the last hour. An organiser-applied mute has zero
-- flags, so `0 < 3` held and the mute lifted itself on the muted person's next
-- message. The moderator saw the action succeed and it undid itself.
--
-- `muted_by IS NULL` means the mute was automatic and the timer may lift it.
-- A non-null value means a human decided, and only a human undoes it.
ALTER TABLE "chat_group_members"
  ADD COLUMN "muted_at" TIMESTAMPTZ(6),
  ADD COLUMN "muted_by" TEXT;

-- Existing mutes are backfilled as AUTOMATIC (muted_by stays null).
--
-- The alternative -- treating them all as manual -- would freeze every mute
-- currently in the database permanently, including the auto-mutes that are
-- supposed to expire in an hour. Wrongly expiring a manual mute costs one
-- re-mute; wrongly making an auto-mute permanent is a silent ban nobody
-- applied and nobody can find.
UPDATE "chat_group_members"
   SET "muted_at" = COALESCE("updated_at", "created_at")
 WHERE "status" = 'muted' AND "muted_at" IS NULL;
