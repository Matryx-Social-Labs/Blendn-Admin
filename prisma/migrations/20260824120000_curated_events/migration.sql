-- Curated events, and the funnel that turns one into an organiser's.
--
-- An event the platform added from a public listing, so a city with no supply
-- has something in it. The real organiser then claims it, which is the
-- acquisition, and approval is a single column write because
-- `eventPermissions` already reads `organizer_org_id`.

-- `curated_at` is the discriminator, and it has to be a column of its own.
--
-- `organizer_org_id IS NULL` cannot mean "unclaimed": it is also true of every
-- legacy row and of every event created before anything wrote that column --
-- which, measured against production on 2026-08-24, is 18 of 28 events. Reusing
-- it would have offered a stranger the chance to claim a real organiser's event.
ALTER TABLE "events"
  ADD COLUMN "curated_at" TIMESTAMPTZ(6),
  ADD COLUMN "source_url" TEXT,
  ADD COLUMN "claimed_at" TIMESTAMPTZ(6);

-- The feed, search and city counts all filter `visibility = 'public'`, and the
-- curation queue needs the unclaimed ones. Partial, because curated events are
-- a small minority of the table and always will be.
CREATE INDEX "events_curated_at_idx" ON "events" ("curated_at")
  WHERE "curated_at" IS NOT NULL;

CREATE TYPE "event_claim_status" AS ENUM ('pending', 'approved', 'declined', 'superseded');

CREATE TABLE "event_claims" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"      UUID NOT NULL,
  -- Nullable, unlike venue_claims. A curated event's real organiser usually has
  -- no account -- that is why the event was curated -- so the claim arrives
  -- before the organisation exists and carries `onboarding_id` instead.
  "org_id"        UUID,
  "onboarding_id" UUID,
  "filed_by"      TEXT,
  "contact_email" TEXT NOT NULL,
  "note"          TEXT,
  "status"        "event_claim_status" NOT NULL DEFAULT 'pending',
  "flags"         JSONB,
  "reviewed_by"   TEXT,
  "reviewed_at"   TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "event_claims_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
  CONSTRAINT "event_claims_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE,

  -- Exactly one route in. A claim with neither has nothing to approve into; a
  -- claim with both is two answers to one question.
  CONSTRAINT "event_claims_one_claimant"
    CHECK (("org_id" IS NULL) <> ("onboarding_id" IS NULL))
);

CREATE INDEX "event_claims_status_idx"   ON "event_claims" ("status");
CREATE INDEX "event_claims_event_id_idx" ON "event_claims" ("event_id");
CREATE INDEX "event_claims_org_id_idx"   ON "event_claims" ("org_id");

-- Deliberately NO unique on (event_id, org_id).
--
-- `venue_claims` has one and updates in place, which keeps its queue tidy and
-- hides how many times somebody has asked. Here the count is the signal: a
-- third claim on one event is the most useful thing a reviewer can know, and an
-- upsert is exactly what would erase it.
--
-- Instead, one PENDING claim per claimant per event, so re-filing while a
-- decision is outstanding cannot stack duplicates in the queue.
CREATE UNIQUE INDEX "event_claims_one_pending_per_org"
  ON "event_claims" ("event_id", "org_id")
  WHERE "status" = 'pending' AND "org_id" IS NOT NULL;

CREATE UNIQUE INDEX "event_claims_one_pending_per_email"
  ON "event_claims" ("event_id", lower("contact_email"))
  WHERE "status" = 'pending' AND "org_id" IS NULL;
