-- A venue can be claimed by somebody with no account (step 1, plan v2 §3).
--
-- Every venue is live from day one, seeded by the founders, so the person who
-- runs a place usually meets it on Blendn before they have a host account. The
-- public page /claim/venue/[venueId] files their claim against the onboarding
-- application that will create their organisation -- the same route in that
-- event_claims has had since 20260824120000_curated_events.
--
-- Filing grants nothing. A person reads every claim, and approving one still
-- needs the application approved first, which is what creates the
-- organisation the venue is handed to.
--
-- Rolling back is two steps, not one: decide or delete every claim with
-- org_id IS NULL first, then restore NOT NULL on org_id and filed_by. A plain
-- reversal fails on those rows.

ALTER TABLE "venue_claims"
  ALTER COLUMN "org_id" DROP NOT NULL,
  ALTER COLUMN "filed_by" DROP NOT NULL,
  ADD COLUMN "onboarding_id" UUID,
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "note" TEXT;

-- Exactly one route in, as on event_claims: a claim with neither has nothing
-- to approve into, and a claim with both is two answers to one question.
ALTER TABLE "venue_claims" ADD CONSTRAINT "venue_claims_one_claimant"
  CHECK (("org_id" IS NULL) <> ("onboarding_id" IS NULL));

-- A claim with no account has nobody to write back to but this address.
ALTER TABLE "venue_claims" ADD CONSTRAINT "venue_claims_public_has_contact"
  CHECK ("onboarding_id" IS NULL OR "contact_email" IS NOT NULL);

-- One pending claim per address per venue for the no-account route. The
-- account route keeps venue_claims_venue_id_org_id_key, which Postgres does not
-- apply to the NULL org_id these rows carry.
CREATE UNIQUE INDEX "venue_claims_one_pending_per_email"
  ON "venue_claims" ("venue_id", lower("contact_email"))
  WHERE "status" = 'pending' AND "org_id" IS NULL;
