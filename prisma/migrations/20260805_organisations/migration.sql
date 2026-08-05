-- Organisations: a host is a company, not a login.
--
-- `events.organizer_id` and `venues.owner_id` both pointed at a User, which
-- meant Byg Brewski *was* one person's account: their colleagues could not
-- help, and if that person left the venue was orphaned.
--
-- Everything becomes an organisation, including a sole trader — `kind`
-- distinguishes them, so an individual organiser exists with one member and no
-- GSTIN while a venue owner must be a company. A uniform shape beats a
-- user-or-org union at every call site.
--
-- The old user columns are KEPT. `organizer_id` still answers "who created
-- this", which is a different question from "who is accountable" and stays
-- useful for audit and for a member's own event list.

CREATE TYPE "organisation_kind" AS ENUM ('individual', 'company');
CREATE TYPE "organisation_status" AS ENUM ('pending', 'verified', 'suspended');
CREATE TYPE "org_role" AS ENUM ('owner', 'admin', 'staff');

CREATE TABLE "organisations" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind"         "organisation_kind" NOT NULL DEFAULT 'individual',
    "display_name" TEXT NOT NULL,
    "legal_name"   TEXT,
    "gstin"        TEXT,
    "address"      TEXT,
    "website"      TEXT,
    "status"       "organisation_status" NOT NULL DEFAULT 'pending',
    "verified_at"  TIMESTAMPTZ(6),
    "verified_by"  TEXT,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organisation_members" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"             UUID NOT NULL,
    "user_id"            TEXT NOT NULL,
    "role"               "org_role" NOT NULL DEFAULT 'staff',
    "is_primary_contact" BOOLEAN NOT NULL DEFAULT false,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organisation_members_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One membership row per person per org.
CREATE UNIQUE INDEX "organisation_members_org_id_user_id_key"
    ON "organisation_members"("org_id", "user_id");
CREATE INDEX "organisation_members_user_id_idx" ON "organisation_members"("user_id");
CREATE INDEX "organisation_members_org_id_idx" ON "organisation_members"("org_id");
CREATE INDEX "organisations_status_idx" ON "organisations"("status");

ALTER TABLE "events" ADD COLUMN "organizer_org_id" UUID;
ALTER TABLE "venues" ADD COLUMN "owner_org_id" UUID;

-- SET NULL, not CASCADE. Deleting an organisation must not delete its events
-- and venues along with every attendee's history attached to them.
ALTER TABLE "events" ADD CONSTRAINT "events_organizer_org_id_fkey"
    FOREIGN KEY ("organizer_org_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "venues" ADD CONSTRAINT "venues_owner_org_id_fkey"
    FOREIGN KEY ("owner_org_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "events_organizer_org_id_idx" ON "events"("organizer_org_id");
CREATE INDEX "venues_owner_org_id_idx" ON "venues"("owner_org_id");

-- ---------------------------------------------------------------------------
-- Backfill. This is the dangerous part: authorization now reads these rows, so
-- a host whose org is missing loses access to their own events silently.
--
-- One `individual` org per existing host, named after them, with that user as
-- `owner` and primary contact. Status `verified` — they were already operating,
-- and marking them `pending` would suspend live hosts to satisfy a new column.
-- ---------------------------------------------------------------------------

-- The org id is DERIVED from the user id, not random. Two hosts can share a
-- display name — joining the member insert on the name would cross-attach them
-- to each other's organisations, and the symptom would be one host quietly
-- seeing another's events. A deterministic id makes the join exact.
INSERT INTO "organisations" ("id", "kind", "display_name", "status", "verified_at")
SELECT uuid_in(md5('blendn-org:' || u."id")::cstring),
       'individual',
       COALESCE(NULLIF(u."name", ''), split_part(u."email", '@', 1)),
       'verified',
       CURRENT_TIMESTAMP
FROM "User" u
WHERE u."role" IN ('organizer', 'venue_owner')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "organisation_members" ("id", "org_id", "user_id", "role", "is_primary_contact")
SELECT gen_random_uuid(),
       uuid_in(md5('blendn-org:' || u."id")::cstring),
       u."id",
       'owner',
       true
FROM "User" u
WHERE u."role" IN ('organizer', 'venue_owner')
ON CONFLICT ("org_id", "user_id") DO NOTHING;

-- Point existing events and venues at their owner's new org.
UPDATE "events" e
SET "organizer_org_id" = m."org_id"
FROM "organisation_members" m
WHERE m."user_id" = e."organizer_id" AND e."organizer_org_id" IS NULL;

UPDATE "venues" v
SET "owner_org_id" = m."org_id"
FROM "organisation_members" m
WHERE m."user_id" = v."owner_id" AND v."owner_org_id" IS NULL;
