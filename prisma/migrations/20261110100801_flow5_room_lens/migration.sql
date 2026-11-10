-- Flow 5 · P-A (SCRUM-1042): the room's lens per event category, and a person's answer to tonight's question.
-- Additive only. The one ALTER on a live table adds a nullable column with no default (metadata-only, no rewrite).
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
-- lock_timeout so a queued ALTER on event_match_preferences fails fast rather than stalling the room's reads.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "event_match_preferences" ADD COLUMN "tonight_answer" VARCHAR(140);

CREATE TABLE "room_lenses" (
    "key" TEXT NOT NULL,
    "question" VARCHAR(140),
    CONSTRAINT "room_lenses_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "category_lenses" (
    "category_slug" TEXT NOT NULL,
    "lens_key" TEXT NOT NULL,
    CONSTRAINT "category_lenses_pkey" PRIMARY KEY ("category_slug")
);
CREATE INDEX "category_lenses_lens_key_idx" ON "category_lenses"("lens_key");
ALTER TABLE "category_lenses" ADD CONSTRAINT "category_lenses_lens_key_fkey"
  FOREIGN KEY ("lens_key") REFERENCES "room_lenses"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The lenses and their questions, as the owner approved them (Flow 5 NOTES § 3). venue_night asks nothing.
INSERT INTO "room_lenses" ("key", "question") VALUES
  ('work',        'What are you working on?'),
  ('music',       'Who are you hoping they play?'),
  ('arts',        'What are you here to see?'),
  ('social',      'What should nobody miss?'),
  ('active',      'First time, or a regular?'),
  ('venue_night', NULL);

-- Every parent slug in scripts/seed-categories.ts. A child's own row wins over its parent's.
INSERT INTO "category_lenses" ("category_slug", "lens_key") VALUES
  ('tech',                  'work'),
  ('networking',            'work'),
  ('business-professional', 'work'),
  ('music',                 'music'),
  ('nightlife',             'music'),
  ('nightlife-comedy',      'social'),
  ('arts-culture',          'arts'),
  ('food-drink',            'social'),
  ('social',                'social'),
  ('community',             'social'),
  ('markets-fairs',         'social'),
  ('learning',              'social'),
  ('sports',                'active'),
  ('ipl',                   'active'),
  ('outdoor',               'active'),
  ('wellness',              'active');

COMMIT;
