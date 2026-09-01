-- RENAMED from `20260805_org_onboarding`, and made idempotent. Why:
--
-- It sorted BEFORE `20260805_organisations` -- same date, and `org_o` beats
-- `orga` alphabetically -- while depending on the `organisations` table that
-- migration creates. So on any database built by replaying migrations in order
-- it failed with `relation "organisations" does not exist`.
--
-- Nothing noticed for a year, because no such database was ever built.
-- Production and staging were created with `db push` and had every table
-- before either migration ran, so both were recorded as applied without their
-- order ever being exercised. CI worked around the whole chain with `db push`
-- too. The bug was real from the day it was written and unreachable until
-- somebody restored from scratch.
--
-- Renaming rather than editing, because Prisma checksums applied migrations:
-- editing this file in place would make `migrate deploy` fail on every
-- environment that already ran it. Under a new name it is simply a new
-- migration, so existing environments run it once -- which is why every
-- statement below is now a no-op against a database that already has these
-- objects. The old name keeps its row and its directory is gone, which
-- `migrate deploy` tolerates.

-- Tenant onboarding: how an organisation gets created, proves itself, and
-- lets more people in.
--
-- v0.18.0 shipped `organisations` and `organisation_members` with roles
-- already modelled — that is the tenant model. Nothing wrote to it except the
-- backfill, so every host has a single-member org and no way to add a second
-- person. These four tables are the access lifecycle around it.
--
-- Purely additive: no existing table is altered, so nothing that works today
-- can break on deploy.

DO $$ BEGIN
    CREATE TYPE "domain_verify_method" AS ENUM ('dns_txt', 'email_role');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    CREATE TYPE "join_request_status" AS ENUM ('pending', 'approved', 'declined');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    CREATE TYPE "onboarding_tier" AS ENUM ('domain', 'needs_proof');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    CREATE TYPE "onboarding_status" AS ENUM ('pending', 'email_pending', 'approved', 'declined');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "organisation_domains" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"             UUID NOT NULL,
    "domain"             TEXT NOT NULL,
    "method"             "domain_verify_method" NOT NULL DEFAULT 'dns_txt',
    "verification_token" TEXT NOT NULL,
    "verified_at"        TIMESTAMPTZ(6),
    "verified_by"        TEXT,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organisation_domains_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "organisation_domains" ADD CONSTRAINT "organisation_domains_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- The load-bearing constraint. Without it two organisations could each verify
-- `bygbrewski.com` and each would then auto-accept the other's staff.
CREATE UNIQUE INDEX IF NOT EXISTS "organisation_domains_domain_key" ON "organisation_domains"("domain");
CREATE INDEX IF NOT EXISTS "organisation_domains_org_id_idx" ON "organisation_domains"("org_id");

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "organisation_invites" (
    "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"                 UUID NOT NULL,
    "email"                  TEXT NOT NULL,
    "role"                   "org_role" NOT NULL DEFAULT 'staff',
    -- SHA-256 hex, never the token. A database dump must not contain usable
    -- invitations to other people's dashboards.
    "token_hash"             TEXT NOT NULL,
    "expires_at"             TIMESTAMPTZ(6) NOT NULL,
    "invited_by"             TEXT NOT NULL,
    "accepted_at"            TIMESTAMPTZ(6),
    "revoked_at"             TIMESTAMPTZ(6),
    "domain_override_reason" TEXT,
    "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organisation_invites_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "organisation_invites" ADD CONSTRAINT "organisation_invites_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "organisation_invites_token_hash_key" ON "organisation_invites"("token_hash");
CREATE INDEX IF NOT EXISTS "organisation_invites_org_id_idx" ON "organisation_invites"("org_id");
CREATE INDEX IF NOT EXISTS "organisation_invites_email_idx" ON "organisation_invites"("email");

-- ---------------------------------------------------------------------------
-- Join requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "organisation_join_requests" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"     UUID NOT NULL,
    "user_id"    TEXT NOT NULL,
    "status"     "join_request_status" NOT NULL DEFAULT 'pending',
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organisation_join_requests_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "organisation_join_requests" ADD CONSTRAINT "organisation_join_requests_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TABLE "organisation_join_requests" ADD CONSTRAINT "organisation_join_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "organisation_join_requests_org_id_user_id_key"
    ON "organisation_join_requests"("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "organisation_join_requests_org_id_idx" ON "organisation_join_requests"("org_id");
-- user_id needs its own index: the composite unique above leads with org_id, so
-- it cannot serve the FK check that runs on every User delete.
CREATE INDEX IF NOT EXISTS "organisation_join_requests_user_id_idx" ON "organisation_join_requests"("user_id");

-- ---------------------------------------------------------------------------
-- Onboarding applications
-- ---------------------------------------------------------------------------

-- An application is deliberately NOT a User. Creating an account on submit
-- would make the public form a way to mint dashboard logins; approval is what
-- creates the org, the user, and the membership together.
CREATE TABLE IF NOT EXISTS "organiser_onboarding_requests" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind"              "organisation_kind" NOT NULL DEFAULT 'company',
    "display_name"      TEXT NOT NULL,
    "legal_name"        TEXT,
    "gstin"             TEXT,
    "website"           TEXT,
    "address"           TEXT,
    "city"              TEXT,
    "contact_name"      TEXT NOT NULL,
    "contact_email"     TEXT NOT NULL,
    "contact_phone"     TEXT,
    "requested_role"    "user_role" NOT NULL DEFAULT 'organizer',
    "email_verified_at" TIMESTAMPTZ(6),
    "tier"              "onboarding_tier" NOT NULL DEFAULT 'needs_proof',
    "status"            "onboarding_status" NOT NULL DEFAULT 'pending',
    "review_note"       TEXT,
    "reviewed_by"       TEXT,
    "reviewed_at"       TIMESTAMPTZ(6),
    "decline_reason"    TEXT,
    "org_id"            UUID,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organiser_onboarding_requests_pkey" PRIMARY KEY ("id")
);

-- SET NULL, not CASCADE: deleting an organisation must not erase the record of
-- how it was approved.
DO $$ BEGIN
    ALTER TABLE "organiser_onboarding_requests" ADD CONSTRAINT "organiser_onboarding_requests_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "organiser_onboarding_requests_status_idx" ON "organiser_onboarding_requests"("status");
CREATE INDEX IF NOT EXISTS "organiser_onboarding_requests_contact_email_idx"
    ON "organiser_onboarding_requests"("contact_email");
-- The org_id FK is nullable and rarely queried, but SET NULL on organisation
-- delete still checks it, and an unindexed FK is a seq scan per delete.
CREATE INDEX IF NOT EXISTS "organiser_onboarding_requests_org_id_idx" ON "organiser_onboarding_requests"("org_id");

CREATE TABLE IF NOT EXISTS "onboarding_email_tokens" (
    "token_hash" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at"    TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "onboarding_email_tokens_pkey" PRIMARY KEY ("token_hash")
);

CREATE INDEX IF NOT EXISTS "onboarding_email_tokens_request_id_idx" ON "onboarding_email_tokens"("request_id");
