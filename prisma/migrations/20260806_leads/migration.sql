-- Leads: demo requests from the organiser landing page.
--
-- Deliberately separate from organiser_onboarding_requests. A lead is someone
-- asking for a walkthrough; an application is someone asking for platform
-- access. Merging them would put an unvetted marketing contact into a queue
-- that grants access.

CREATE TYPE "lead_type" AS ENUM ('demo_request');
CREATE TYPE "lead_status" AS ENUM ('new', 'contacted', 'qualified', 'converted', 'archived', 'spam');

CREATE TABLE "leads" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "type"         "lead_type"   NOT NULL,
  "status"       "lead_status" NOT NULL DEFAULT 'new',
  "source"       TEXT          NOT NULL DEFAULT 'organizers-landing',

  "email"        TEXT NOT NULL,
  "email_root"   TEXT NOT NULL,
  "name"         TEXT,
  "organization" TEXT,
  "event_types"  TEXT,
  "city"         TEXT,

  "user_agent"   TEXT,
  "ip"           INET,
  "open_key"     TEXT,

  "assigned_to"  TEXT REFERENCES "User"("id") ON DELETE SET NULL,

  "submitted_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "contacted_at" TIMESTAMPTZ(6)
);

CREATE TABLE "lead_notes" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id"    UUID NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "author_id"  TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "body"       TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Idempotency, scoped to leads that are still open.
--
-- A permanent UNIQUE(type, email) — which the contract originally specified —
-- means a person who requests a demo in August and again in February is shown
-- success, stored nowhere, and never notified. That is the same silent-drop
-- class this endpoint exists to prevent, just slower.
--
-- The natural expression is a partial unique index, but Prisma cannot declare
-- one, so it would exist only here: applied in production by `migrate deploy`
-- and missing in CI, which uses `db push`. A nullable unique column has the
-- same semantics (Postgres permits unlimited NULLs in a unique index) and both
-- paths build it identically.
CREATE UNIQUE INDEX "leads_open_key_key" ON "leads" ("open_key");

CREATE INDEX "leads_status_created_idx"     ON "leads" ("status", "created_at" DESC);
CREATE INDEX "leads_type_created_idx"       ON "leads" ("type", "created_at" DESC);
CREATE INDEX "leads_email_idx"              ON "leads" ("email");
CREATE INDEX "leads_email_root_created_idx" ON "leads" ("email_root", "created_at");
CREATE INDEX "leads_assigned_to_idx"        ON "leads" ("assigned_to");

CREATE INDEX "lead_notes_lead_id_created_at_idx" ON "lead_notes" ("lead_id", "created_at");
CREATE INDEX "lead_notes_author_id_idx"          ON "lead_notes" ("author_id");
