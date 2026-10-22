-- A moderator or the automatic check took your board post down (SV9): its
-- author is told by a push of this kind, recorded in the bell like every other.
--
-- Its own migration because Postgres will not use an enum value in the
-- transaction that added it, and so it has no BEGIN/COMMIT: `ADD VALUE` is a
-- single statement, and IF NOT EXISTS makes a re-run harmless. Rolling back: a
-- value cannot be dropped from an enum in place; a NEW forward migration
-- recreates the type without it, once no notification row uses it.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'board_post_removed';
