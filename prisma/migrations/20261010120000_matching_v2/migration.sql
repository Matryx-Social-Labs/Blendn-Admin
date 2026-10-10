-- Matching v2 (plan v2 §8, step 10): the "about you" fields, this-or-that
-- answers, and the IPL teams and cuisine loves as interest leaves.
--
-- Display only, every column here: languages, home state and sign are printed
-- as named overlaps and never scored (lib/overlaps.ts). Nothing here is, or may
-- become, caste, community, religion, kundli or veg / non-veg
-- (__tests__/never-build-fields.test.ts).
--
-- Additive. Rolling back is a NEW forward migration, never SQL by hand
-- against staging or production: DROP TABLE this_or_that_answers; drop the
-- constraints and the five profile columns; delete the leaves added below
-- only if no user_interests or event_categories row points at them (re-tag
-- first — the slugs are what links carry). A rollback of the CODE alone leaves
-- columns nothing reads, which is safe.

-- `prisma migrate deploy` sends a file statement by statement, outside any
-- transaction, so this file is its own: SET LOCAL holds only inside it, and a
-- failure part-way leaves nothing half-applied.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "profiles" ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "profiles" ADD COLUMN "home_state" TEXT;
ALTER TABLE "profiles" ADD COLUMN "sun_sign" TEXT;
ALTER TABLE "profiles" ADD COLUMN "sign_system" TEXT;
ALTER TABLE "profiles" ADD COLUMN "shows_up_badge" BOOLEAN NOT NULL DEFAULT false;

-- A sign is picked in one calendar or not at all: both or neither, and only
-- the two calendars the editor offers. Every existing row is (NULL, NULL).
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_sign_shape" CHECK (
  ("sun_sign" IS NULL) = ("sign_system" IS NULL)
  AND ("sign_system" IS NULL OR "sign_system" IN ('western', 'rashi'))
);

CREATE TABLE "this_or_that_answers" (
  "user_id" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "choice" TEXT NOT NULL,
  "answered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "this_or_that_answers_pkey" PRIMARY KEY ("user_id", "question"),
  CONSTRAINT "this_or_that_choice" CHECK ("choice" IN ('a', 'b')),
  CONSTRAINT "this_or_that_answers_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The leaves (lib/about-you.ts IPL_TEAMS, CUISINE_LOVES; the same rows
-- scripts/seed-categories.ts upserts). ON CONFLICT on the slug: an environment
-- that already has a row keeps it — production's "Food & Drink" is adopted,
-- never duplicated, exactly as the seed script's upsert-on-slug does.
INSERT INTO "categories" ("id", "name", "slug")
VALUES (gen_random_uuid(), 'IPL', 'ipl'), (gen_random_uuid(), 'Food & Drink', 'food-drink')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "categories" ("id", "name", "slug", "description", "parent_id")
SELECT gen_random_uuid(), v.name, v.slug, v.description, p.id
  FROM (VALUES
  ('CSK', 'ipl-csk', 'Chennai Super Kings'),
  ('DC', 'ipl-dc', 'Delhi Capitals'),
  ('GT', 'ipl-gt', 'Gujarat Titans'),
  ('KKR', 'ipl-kkr', 'Kolkata Knight Riders'),
  ('LSG', 'ipl-lsg', 'Lucknow Super Giants'),
  ('MI', 'ipl-mi', 'Mumbai Indians'),
  ('PBKS', 'ipl-pbks', 'Punjab Kings'),
  ('RR', 'ipl-rr', 'Rajasthan Royals'),
  ('RCB', 'ipl-rcb', 'Royal Challengers Bengaluru'),
  ('SRH', 'ipl-srh', 'Sunrisers Hyderabad')
  ) AS v(name, slug, description)
  JOIN "categories" p ON p.slug = 'ipl'
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "categories" ("id", "name", "slug", "parent_id")
SELECT gen_random_uuid(), v.name, v.slug, p.id
  FROM (VALUES
  ('Biryani', 'food-drink-biryani'),
  ('Dosa', 'food-drink-dosa'),
  ('Chaat', 'food-drink-chaat'),
  ('Momos', 'food-drink-momos'),
  ('Street food', 'food-drink-street-food'),
  ('Desserts', 'food-drink-desserts'),
  ('Indo-Chinese', 'food-drink-indo-chinese'),
  ('Pizza', 'food-drink-pizza')
  ) AS v(name, slug)
  JOIN "categories" p ON p.slug = 'food-drink'
ON CONFLICT ("slug") DO NOTHING;

COMMIT;
