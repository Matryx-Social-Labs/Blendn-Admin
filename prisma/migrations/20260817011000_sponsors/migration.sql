-- CreateEnum
CREATE TYPE "sponsor_status" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "sponsor_claim_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "placement_status" AS ENUM ('draft', 'proposed', 'approved', 'cancelled');

-- CreateEnum
CREATE TYPE "charge_status" AS ENUM ('draft', 'agreed', 'settled', 'void');

-- CreateEnum
CREATE TYPE "currency_code" AS ENUM ('INR');


-- AlterTable
ALTER TABLE "event_sponsored_messages" ADD COLUMN     "claim_token" UUID,
ADD COLUMN     "claimed_at" TIMESTAMPTZ(6),
ADD COLUMN     "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deactivated_reason" TEXT,
ADD COLUMN     "next_send_at" TIMESTAMPTZ(6),
ADD COLUMN     "sponsor_id" UUID;

-- CreateTable
CREATE TABLE "sponsors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "org_id" UUID,
    "logo_url" TEXT,
    "website" TEXT,
    "claimed_at" TIMESTAMPTZ(6),
    "status" "sponsor_status" NOT NULL DEFAULT 'active',
    "merged_into" UUID,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "sponsors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_sponsors" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "sponsor_id" UUID NOT NULL,
    "status" "placement_status" NOT NULL DEFAULT 'draft',
    "created_by" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_sponsors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsor_claims" (
    "id" UUID NOT NULL,
    "sponsor_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "filed_by" TEXT NOT NULL,
    "status" "sponsor_claim_status" NOT NULL DEFAULT 'pending',
    "is_dispute" BOOLEAN NOT NULL DEFAULT false,
    "gstin" TEXT,
    "evidence" JSONB,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsor_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "placement_charges" (
    "id" UUID NOT NULL,
    "placement_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" "currency_code" NOT NULL,
    "amount_base" INTEGER,
    "fx_rate" DECIMAL(18,8),
    "fx_date" DATE,
    "status" "charge_status" NOT NULL DEFAULT 'draft',
    "priced_by" TEXT NOT NULL,
    "agreed_at" TIMESTAMPTZ(6),
    "settled_at" TIMESTAMPTZ(6),
    "external_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "placement_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsored_creatives" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "media_url" TEXT,
    "media_type" TEXT,
    "media_checksum" TEXT,
    "media_version_id" TEXT,
    "moderation_status" "moderation_status_type" NOT NULL DEFAULT 'pending',
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsored_creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsored_message_sends" (
    "id" UUID NOT NULL,
    "sponsored_message_id" UUID NOT NULL,
    "creative_id" UUID NOT NULL,
    "chat_message_id" UUID,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "members" INTEGER NOT NULL,
    "live_connected" INTEGER NOT NULL,
    "recipient_hashes" TEXT[],

    CONSTRAINT "sponsored_message_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_grants" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "max_bytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "version_id" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_polls" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "closes_at" TIMESTAMPTZ(6),
    "results_visible" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_poll_options" (
    "id" UUID NOT NULL,
    "poll_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "chat_poll_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_poll_votes" (
    "id" UUID NOT NULL,
    "poll_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_poll_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sponsors_org_id_idx" ON "sponsors"("org_id");

-- CreateIndex
CREATE INDEX "sponsors_status_idx" ON "sponsors"("status");

-- CreateIndex
CREATE INDEX "sponsors_name_key_idx" ON "sponsors"("name_key");

-- CreateIndex
CREATE INDEX "event_sponsors_event_id_idx" ON "event_sponsors"("event_id");

-- CreateIndex
CREATE INDEX "event_sponsors_sponsor_id_idx" ON "event_sponsors"("sponsor_id");

-- CreateIndex
CREATE INDEX "event_sponsors_status_idx" ON "event_sponsors"("status");

-- CreateIndex
CREATE UNIQUE INDEX "event_sponsors_event_id_sponsor_id_key" ON "event_sponsors"("event_id", "sponsor_id");

-- CreateIndex
CREATE INDEX "sponsor_claims_sponsor_id_idx" ON "sponsor_claims"("sponsor_id");

-- CreateIndex
CREATE INDEX "sponsor_claims_org_id_idx" ON "sponsor_claims"("org_id");

-- CreateIndex
CREATE INDEX "sponsor_claims_status_idx" ON "sponsor_claims"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sponsor_claims_sponsor_id_org_id_key" ON "sponsor_claims"("sponsor_id", "org_id");

-- CreateIndex
CREATE INDEX "placement_charges_placement_id_idx" ON "placement_charges"("placement_id");

-- CreateIndex
CREATE INDEX "placement_charges_status_idx" ON "placement_charges"("status");

-- CreateIndex
CREATE INDEX "placement_charges_priced_by_idx" ON "placement_charges"("priced_by");

-- CreateIndex
CREATE INDEX "sponsored_creatives_message_id_created_at_idx" ON "sponsored_creatives"("message_id", "created_at");

-- CreateIndex
CREATE INDEX "sponsored_message_sends_sponsored_message_id_sent_at_idx" ON "sponsored_message_sends"("sponsored_message_id", "sent_at");

-- CreateIndex
CREATE INDEX "sponsored_message_sends_creative_id_idx" ON "sponsored_message_sends"("creative_id");

-- CreateIndex
CREATE UNIQUE INDEX "sponsored_message_sends_sponsored_message_id_scheduled_for_key" ON "sponsored_message_sends"("sponsored_message_id", "scheduled_for");

-- CreateIndex
CREATE INDEX "upload_grants_expires_at_idx" ON "upload_grants"("expires_at");

-- CreateIndex
CREATE INDEX "upload_grants_org_id_idx" ON "upload_grants"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_grants_key_key" ON "upload_grants"("key");

-- CreateIndex
CREATE UNIQUE INDEX "chat_polls_message_id_key" ON "chat_polls"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_poll_options_poll_id_position_key" ON "chat_poll_options"("poll_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "chat_poll_options_poll_id_id_key" ON "chat_poll_options"("poll_id", "id");

-- CreateIndex
CREATE INDEX "chat_poll_votes_option_id_idx" ON "chat_poll_votes"("option_id");

-- CreateIndex
CREATE INDEX "chat_poll_votes_user_id_idx" ON "chat_poll_votes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_poll_votes_poll_id_user_id_key" ON "chat_poll_votes"("poll_id", "user_id");

-- CreateIndex
CREATE INDEX "event_sponsored_messages_sponsor_id_idx" ON "event_sponsored_messages"("sponsor_id");

-- AddForeignKey
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_sponsors" ADD CONSTRAINT "event_sponsors_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_sponsors" ADD CONSTRAINT "event_sponsors_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsor_claims" ADD CONSTRAINT "sponsor_claims_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsor_claims" ADD CONSTRAINT "sponsor_claims_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_charges" ADD CONSTRAINT "placement_charges_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "event_sponsors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_charges" ADD CONSTRAINT "placement_charges_priced_by_fkey" FOREIGN KEY ("priced_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_sponsored_messages" ADD CONSTRAINT "event_sponsored_messages_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsored_creatives" ADD CONSTRAINT "sponsored_creatives_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "event_sponsored_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsored_message_sends" ADD CONSTRAINT "sponsored_message_sends_sponsored_message_id_fkey" FOREIGN KEY ("sponsored_message_id") REFERENCES "event_sponsored_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsored_message_sends" ADD CONSTRAINT "sponsored_message_sends_creative_id_fkey" FOREIGN KEY ("creative_id") REFERENCES "sponsored_creatives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsored_message_sends" ADD CONSTRAINT "sponsored_message_sends_chat_message_id_fkey" FOREIGN KEY ("chat_message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_polls" ADD CONSTRAINT "chat_polls_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_poll_options" ADD CONSTRAINT "chat_poll_options_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "chat_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_poll_votes" ADD CONSTRAINT "chat_poll_votes_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "chat_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_poll_votes" ADD CONSTRAINT "chat_poll_votes_poll_id_option_id_fkey" FOREIGN KEY ("poll_id", "option_id") REFERENCES "chat_poll_options"("poll_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_poll_votes" ADD CONSTRAINT "chat_poll_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Constraints Prisma cannot express, and the reasons they are not optional.
-- Precedent for hand-written SQL in a migration: 20260805_fk_indexes.
-- ─────────────────────────────────────────────────────────────────────────────

-- One APPROVED claim per brand, whoever filed it.
--
-- `@@unique([sponsor_id, org_id])` on the model stops ONE org filing twice. It
-- does not stop two DIFFERENT orgs both reaching `approved` on the same brand,
-- which is ownership corruption decided by whichever transaction commits last.
-- `venue_claims` has the same gap; it is closed here rather than inherited.
CREATE UNIQUE INDEX IF NOT EXISTS "sponsor_one_approved_claim_idx"
  ON "sponsor_claims" ("sponsor_id")
  WHERE "status" = 'approved';

-- One LIVE charge per placement, so voiding stays recoverable.
--
-- A plain unique on `placement_id` would make `void` terminal: you could never
-- raise a corrected charge after voiding a wrong one, which is the entire point
-- of having the state.
CREATE UNIQUE INDEX IF NOT EXISTS "placement_one_live_charge_idx"
  ON "placement_charges" ("placement_id")
  WHERE "status" <> 'void';

-- One live brand per normalised name per owning org.
--
-- An org may own several brands — a group with multiple labels is real — but
-- not two rows that normalise identically, which is always the duplicate the
-- picker failed to catch. Unclaimed rows (`org_id IS NULL`) are excluded: they
-- are exactly the free-text ones an organiser typed, and deduplicating those is
-- the merge tool's job, not a constraint's.
CREATE UNIQUE INDEX IF NOT EXISTS "sponsor_org_name_key_idx"
  ON "sponsors" ("org_id", "name_key")
  WHERE "deleted_at" IS NULL AND "merged_into" IS NULL AND "org_id" IS NOT NULL;

-- An active campaign must have a brand.
--
-- The scheduler's due-select joins through `sponsor_id`. A null there does not
-- error: the row simply never matches, so the campaign silently never sends and
-- nothing anywhere reports a problem.
ALTER TABLE "event_sponsored_messages"
  ADD CONSTRAINT "sponsored_active_needs_sponsor"
  CHECK (NOT "is_active" OR "sponsor_id" IS NOT NULL);

-- The sweeper's exact predicate, not an idealised one.
--
-- Every column the due-select filters on belongs here or the index is
-- decorative. Partial because most rows are inactive at any moment, so the
-- index stays small.
CREATE INDEX IF NOT EXISTS "sponsored_due_idx"
  ON "event_sponsored_messages" ("next_send_at")
  WHERE "is_active" AND "next_send_at" IS NOT NULL;
