-- Regulars, blind offers and the door pass (step 12, plan v2 §2, §9.1b).
--
-- A venue on Venue Pro writes an offer for its regulars (3+ nights in 30
-- days, after its claim: lib/regulars.ts). We deliver it; the venue sees how
-- many were sent, opened and redeemed — never who — unless a person opts in
-- to being known as a regular there.
--
-- Additive only: four new tables, one enum, a profiles column with a constant
-- default, and a partial unique index on message_reports. Rolling back is a NEW forward
-- migration that drops them (never SQL by hand against staging or
-- production); older code reads none of them, so a rollback of the CODE alone
-- is safe.
--
-- `prisma migrate deploy` sends a file statement by statement, outside any
-- transaction (step 17 review), so this file is its own: SET LOCAL applies,
-- and a half-applied file cannot block the next deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Who an offer is for. Regulars only for now; lapsed and first-timers are
-- the plan's other audiences and wait for the owner to ask.
CREATE TYPE "venue_offer_audience" AS ENUM ('regulars');

CREATE TABLE "venue_offers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "venue_id" UUID NOT NULL,
  -- The organisation that owned the venue when it sent this. Results and the
  -- door read only the current owner's offers, so a venue that changes hands
  -- never shows the new owner the old one's numbers, and never honours its passes.
  "org_id" UUID NOT NULL,
  "created_by" TEXT,
  "text" VARCHAR(140) NOT NULL,
  "audience" "venue_offer_audience" NOT NULL DEFAULT 'regulars',
  -- How many it went to, at send time. Never under 5: an audience under the
  -- floor is refused with nothing written (lib/offer-actions.ts).
  "audience_size" INTEGER NOT NULL,
  "ends_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "venue_offers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_offers_audience_floor" CHECK ("audience_size" >= 5),
  CONSTRAINT "venue_offers_ends_after_start" CHECK ("ends_at" > "created_at")
);
-- Cascade: an offer is the venue's; venues are retired, never deleted, by the product.
ALTER TABLE "venue_offers" ADD CONSTRAINT "venue_offers_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "venue_offers" ADD CONSTRAINT "venue_offers_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "venue_offers" ADD CONSTRAINT "venue_offers_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- The weekly quota and the results list: one venue's offers, newest first.
CREATE INDEX "venue_offers_venue_id_created_at_idx" ON "venue_offers"("venue_id", "created_at");
CREATE INDEX "venue_offers_org_id_idx" ON "venue_offers"("org_id");
-- An account erased with a hard delete sets its offers' author to null: indexed, so that is not a scan.
CREATE INDEX "venue_offers_created_by_idx" ON "venue_offers"("created_by");

-- One row per person an offer went to. The venue never reads `user_id`
-- (__tests__/regulars-never-listed.test.ts): only the push sender and the
-- person themselves do.
CREATE TABLE "venue_offer_sends" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "offer_id" UUID NOT NULL,
  -- The offer's venue, copied so one pass a night per venue can be a unique index.
  "venue_id" UUID NOT NULL,
  -- Null once the person's account is erased: the row stays as a count, its
  -- times cut to the day (app/api/mobile/account/route.ts).
  "user_id" TEXT,
  "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- The person opened the offer in the app.
  "opened_at" TIMESTAMPTZ(6),
  -- The last time the pass was on their screen: the door matches a code
  -- only against passes being shown now.
  "pass_seen_at" TIMESTAMPTZ(6),
  "redeemed_at" TIMESTAMPTZ(6),
  -- The venue's night it was redeemed on (its day_reset_hour): one a night.
  "redeemed_night" DATE,
  CONSTRAINT "venue_offer_sends_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_offer_sends_redeemed_shape" CHECK (("redeemed_at" IS NULL) = ("redeemed_night" IS NULL)),
  CONSTRAINT "venue_offer_sends_redeemed_after_open" CHECK ("redeemed_at" IS NULL OR "opened_at" IS NOT NULL)
);
ALTER TABLE "venue_offer_sends" ADD CONSTRAINT "venue_offer_sends_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "venue_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "venue_offer_sends" ADD CONSTRAINT "venue_offer_sends_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "venue_offer_sends" ADD CONSTRAINT "venue_offer_sends_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- An offer reaches a person once.
CREATE UNIQUE INDEX "venue_offer_sends_offer_id_user_id_key" ON "venue_offer_sends"("offer_id", "user_id");
-- One pass a night per person per venue, whichever offer it is.
CREATE UNIQUE INDEX "venue_offer_sends_one_pass_a_night" ON "venue_offer_sends"("venue_id", "user_id", "redeemed_night")
  WHERE "redeemed_night" IS NOT NULL;
-- The person's own offers, newest first.
CREATE INDEX "venue_offer_sends_user_id_sent_at_idx" ON "venue_offer_sends"("user_id", "sent_at");
-- The door: passes on screen at this venue in the last minutes.
CREATE INDEX "venue_offer_sends_door_idx" ON "venue_offer_sends"("venue_id", "pass_seen_at")
  WHERE "pass_seen_at" IS NOT NULL;

-- "Let this venue know I'm a regular": a row is an explicit yes, and
-- revoking deletes it. No row is no, so a missing answer can never read as yes.
-- The yes is to the organisation that ran the venue when it was given
-- (`org_id`): a venue that changes hands shows its new owner none of them.
-- `created_at` is the record of consent; nothing is written to audit_logs.
CREATE TABLE "venue_regular_optins" (
  "venue_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "org_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "venue_regular_optins_pkey" PRIMARY KEY ("venue_id", "user_id", "org_id")
);
ALTER TABLE "venue_regular_optins" ADD CONSTRAINT "venue_regular_optins_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "venue_regular_optins" ADD CONSTRAINT "venue_regular_optins_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "venue_regular_optins" ADD CONSTRAINT "venue_regular_optins_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "venue_regular_optins_user_id_idx" ON "venue_regular_optins"("user_id");
-- The venue's list (its current owner's yeses), and the organisation's key.
CREATE INDEX "venue_regular_optins_org_id_venue_id_idx" ON "venue_regular_optins"("org_id", "venue_id");

-- "No offers from this venue": a row mutes it.
CREATE TABLE "venue_offer_mutes" (
  "venue_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "venue_offer_mutes_pkey" PRIMARY KEY ("venue_id", "user_id")
);
ALTER TABLE "venue_offer_mutes" ADD CONSTRAINT "venue_offer_mutes_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "venue_offer_mutes" ADD CONSTRAINT "venue_offer_mutes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "venue_offer_mutes_user_id_idx" ON "venue_offer_mutes"("user_id");

-- "Offers from places", the person's one switch for all of them (Settings).
-- On by default; off, no venue's offer reaches them. A constant default is a
-- catalogue change on Postgres 11+, no table rewrite.
ALTER TABLE "profiles" ADD COLUMN "offers_from_places" BOOLEAN NOT NULL DEFAULT true;

-- "Report this offer" files into the existing reports queue as message_type
-- 'venue_offer' (message_id = the offer). One pending report per person per
-- offer: a second tap is the same report.
CREATE UNIQUE INDEX "message_reports_one_pending_offer_report" ON "message_reports"("reporter_id", "message_id")
  WHERE "status" = 'pending' AND "message_type" = 'venue_offer';

COMMIT;
