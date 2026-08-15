-- Orientation becomes plural.
--
-- People hold more than one label — "queer" alongside "bisexual", "asexual"
-- alongside a romantic orientation — and one column made someone pick which
-- part of themselves to omit.
--
-- Backfilled before the drop, in that order, so nobody's existing answer is
-- lost: a single stored label becomes a one-element array. The column is NOT
-- NULL with an empty-array default, so "declared nothing" and "declared an
-- empty set" are the same state — which they are, unlike gender where null and
-- "prefer not to say" mean different things.
ALTER TABLE "profiles" ADD COLUMN "orientations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "profiles"
SET "orientations" = ARRAY["orientation"]
WHERE "orientation" IS NOT NULL AND "orientation" <> '';

ALTER TABLE "profiles" DROP COLUMN "orientation";
