-- What an event offers — a curated vocabulary, and the organiser's assertion.
--
-- The Scene's frame (1141:4917) draws two labelled tiles and nothing populated
-- them. `events.house_rules` is free text and a different thing: a vocabulary
-- can be given an icon, filtered on and translated, where "open bar (from 9)"
-- and "Free drinks!!" are two facts nothing can group.
--
-- The **venue** layer from docs/AMENITIES.md is deliberately not built here.
-- An unowned venue has no list to suggest from, and almost no venue is owned
-- today, so it would be a permission system and a picker that did nothing.

CREATE TABLE "amenities" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "name"       TEXT NOT NULL,
  "slug"       TEXT NOT NULL,
  -- The tile's second line. Optional: not every amenity has a useful
  -- qualifier, and an invented one is worse than none.
  "subtitle"   TEXT,
  -- A Material Symbols name, so the client carries no slug-to-glyph map of
  -- its own to drift from the seed.
  "icon"       TEXT,
  -- Explicit ordering. Alphabetical puts "Accessible Entrance" above
  -- "Open Bar" on every event in the app.
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  -- Retirement, rather than deletion — see the Restrict below.
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "amenities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "amenities_slug_key" ON "amenities" ("slug");
CREATE INDEX "amenities_is_active_sort_order_idx" ON "amenities" ("is_active", "sort_order");

CREATE TABLE "event_amenities" (
  "event_id"   UUID NOT NULL,
  "amenity_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "event_amenities_pkey" PRIMARY KEY ("event_id", "amenity_id")
);

CREATE INDEX "event_amenities_amenity_id_idx" ON "event_amenities" ("amenity_id");

-- Cascade: deleting an event takes its claims with it.
ALTER TABLE "event_amenities"
  ADD CONSTRAINT "event_amenities_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "events"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- **Restrict**, not Cascade: deleting an amenity that events reference would
-- rewrite what those events said they offered. Retirement is `is_active`,
-- which hides it from the picker and leaves history intact.
ALTER TABLE "event_amenities"
  ADD CONSTRAINT "event_amenities_amenity_id_fkey"
  FOREIGN KEY ("amenity_id") REFERENCES "amenities"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The starting vocabulary. Seeded here rather than in a script so a fresh
-- database and a migrated one agree, and re-runnable via the slug conflict.
INSERT INTO "amenities" ("name", "slug", "subtitle", "icon", "sort_order") VALUES
  ('Open Bar',            'open-bar',            'Premium spirits',     'local_bar',        10),
  ('Pro Photo',           'pro-photo',           'Digital gallery',     'camera',           20),
  ('Live Music',          'live-music',          'Performing artists',  'music_note',       30),
  ('DJ Set',              'dj-set',              'Resident selector',   'graphic_eq',       40),
  ('Food Included',       'food-included',       'Served on the night', 'restaurant',       50),
  ('Welcome Drink',       'welcome-drink',       'One on arrival',      'local_drink',      60),
  ('Outdoor Space',       'outdoor-space',       'Terrace or garden',   'deck',             70),
  ('Rooftop',             'rooftop',             'Open air, up high',   'roofing',          80),
  ('Step-free Access',    'step-free-access',    'No stairs to enter',  'accessible',       90),
  ('Accessible Toilets',  'accessible-toilets',  NULL,                  'wc',              100),
  ('Cloakroom',           'cloakroom',           'Bags and coats',      'checkroom',       110),
  ('Parking',             'parking',             'On site',             'local_parking',   120),
  ('Wi-Fi',               'wifi',                'Free for guests',     'wifi',            130),
  ('Quiet Area',          'quiet-area',          'Somewhere to talk',   'volume_off',      140)
ON CONFLICT ("slug") DO NOTHING;
