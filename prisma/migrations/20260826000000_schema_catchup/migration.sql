-- The last of what `db push` created and no migration wrote down.
--
-- After the baseline and the two ordering fixes, replaying the chain onto an
-- empty database produced a schema that still differed from `schema.prisma` in
-- five columns. Found by building both -- one by `migrate deploy`, one by
-- `db push` -- and diffing `information_schema.columns`: 660 columns against
-- 661.
--
-- `chat_messages.moderation_status` is the one that mattered. It is declared in
-- the schema, and the moderation pipeline writes it on every message -- the
-- values `clean`, `flagged`, `hidden` and `unchecked` all live in that column.
-- No migration ever created it. A database built from migrations would have
-- accepted messages and failed to record whether any of them had been checked.
--
-- The four `profiles` array columns are a nullability drift: migrations left
-- them NOT NULL, and `db push` -- which is the authority on what the schema
-- means -- makes them nullable.
--
-- Idempotent, like the rest of these: production and staging already match, so
-- this runs once and changes nothing there.

ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "moderation_status" TEXT;

ALTER TABLE "profiles" ALTER COLUMN "expertise" DROP NOT NULL;
ALTER TABLE "profiles" ALTER COLUMN "goals" DROP NOT NULL;
ALTER TABLE "profiles" ALTER COLUMN "looking_for" DROP NOT NULL;
ALTER TABLE "profiles" ALTER COLUMN "orientations" DROP NOT NULL;
