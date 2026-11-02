-- Ticketing, phase 1 (SCRUM-1008, epic SCRUM-1007): per-market rates, per-event settings, ticket
-- types, orders and their holds, tickets, and the agreement-acceptance record. No route reads or
-- writes any of it yet, and `TICKETING` (lib/env.ts) is off by default.
--
-- Currency is text matching `markets.currency`, as `markets` itself is, not `currency_code`: that
-- enum holds INR alone, and `ALTER TYPE ... ADD VALUE` would need a migration per country whose new
-- value cannot be used in the transaction that adds it. A ticket type carries no currency: every
-- amount on an event is in its fee snapshot's, so one event has one currency by construction.
--
-- Every CHECK, the partial index and the trigger below exist only here: `db push` creates none.
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "ticketing_mode" AS ENUM ('off', 'native', 'external');
CREATE TYPE "ticket_refund_policy" AS ENUM ('none', 'until_7d', 'until_24h');
CREATE TYPE "ticket_order_status" AS ENUM ('pending', 'paid', 'refunded', 'expired', 'cancelled');

-- Markets: the rates, as data. Slab i starts at ticket ticket_fee_slab_from[i] (marginal per event).
ALTER TABLE "markets"
  ADD COLUMN "ticketing_mode" "ticketing_mode" NOT NULL DEFAULT 'off',
  ADD COLUMN "ticket_fee_slab_from" INTEGER[] NOT NULL DEFAULT ARRAY[1, 101, 501]::INTEGER[],
  ADD COLUMN "ticket_fee_slab_bps" INTEGER[] NOT NULL DEFAULT ARRAY[500, 350, 200]::INTEGER[],
  ADD COLUMN "ticket_fee_min_minor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ticket_fee_tax_bps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ticket_processing_bps" INTEGER NOT NULL DEFAULT 0,
  -- Same length, at least one, the first starting at ticket 1 (ascending order is parseFeeSchedule's).
  ADD CONSTRAINT "markets_ticket_fee_slabs_shape" CHECK (
    cardinality("ticket_fee_slab_from") >= 1
    AND cardinality("ticket_fee_slab_from") = cardinality("ticket_fee_slab_bps")
    AND "ticket_fee_slab_from"[1] = 1
    AND array_position("ticket_fee_slab_from", NULL) IS NULL
    AND array_position("ticket_fee_slab_bps", NULL) IS NULL
  ),
  ADD CONSTRAINT "markets_ticket_fee_rates_range" CHECK (
    0 <= ALL ("ticket_fee_slab_bps") AND 10000 >= ALL ("ticket_fee_slab_bps")
    AND "ticket_fee_tax_bps" BETWEEN 0 AND 10000
    AND "ticket_processing_bps" BETWEEN 0 AND 10000
    AND "ticket_fee_min_minor" >= 0
  );

-- India sells natively: 5 / 3.5 / 2%, ₹10 minimum, GST 18% on the fee, processing ~2% + GST.
-- Canada links out until Razorpay confirms CAD and a payout path (ticketing-business-model.md §1);
-- its rates are ready for the day it switches: CA$0.75 minimum, no tax on the fee here yet, and
-- Razorpay international ~3% + GST, before FX.
UPDATE "markets" SET "ticketing_mode" = 'native', "ticket_fee_min_minor" = 1000, "ticket_fee_tax_bps" = 1800, "ticket_processing_bps" = 236 WHERE "code" = 'IN';
UPDATE "markets" SET "ticketing_mode" = 'external', "ticket_fee_min_minor" = 75, "ticket_fee_tax_bps" = 0, "ticket_processing_bps" = 354 WHERE "code" = 'CA';

-- Events: off is the default and today's behaviour for every existing row.
ALTER TABLE "events"
  ADD COLUMN "ticketing_mode" "ticketing_mode" NOT NULL DEFAULT 'off',
  ADD COLUMN "external_ticket_url" TEXT,
  ADD COLUMN "refund_policy" "ticket_refund_policy" NOT NULL DEFAULT 'none',
  ADD COLUMN "fees_absorbed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ticket_fee_schedule" JSONB,
  ADD CONSTRAINT "events_ticketing_external_needs_url" CHECK ("ticketing_mode" <> 'external' OR "external_ticket_url" IS NOT NULL),
  -- https, a host with no user name in it, no whitespace, bounded: what `httpsUrl()` (lib/https-url.ts),
  -- the writer's validator, lets through. That parser is the full check; this is the floor under it.
  ADD CONSTRAINT "events_external_ticket_url_https" CHECK (
    "external_ticket_url" IS NULL
    OR ("external_ticket_url" ~* '^https://[^/?#@[:space:]]+([/?#][^[:space:]]*)?$' AND char_length("external_ticket_url") <= 2048)
  ),
  -- IS NOT NULL spelled out: jsonb_typeof(NULL) is NULL, and a CHECK that evaluates to NULL passes.
  ADD CONSTRAINT "events_ticketing_native_needs_schedule" CHECK (
    "ticketing_mode" <> 'native' OR ("ticket_fee_schedule" IS NOT NULL AND jsonb_typeof("ticket_fee_schedule") = 'object')
  ),
  -- A venue day is the hidden room people Go Live in: never ticketed.
  ADD CONSTRAINT "events_venue_day_not_ticketed" CHECK ("kind" = 'event' OR "ticketing_mode" = 'off');

CREATE TABLE "ticket_types" (
  "id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "price_minor" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "sold" INTEGER NOT NULL DEFAULT 0,
  "held" INTEGER NOT NULL DEFAULT 0,
  "max_per_order" INTEGER NOT NULL DEFAULT 10,
  "sale_starts_at" TIMESTAMPTZ(6),
  "sale_ends_at" TIMESTAMPTZ(6),
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "sort" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ticket_types_price_non_negative" CHECK ("price_minor" >= 0),
  CONSTRAINT "ticket_types_counts_non_negative" CHECK ("quantity" >= 0 AND "sold" >= 0 AND "held" >= 0),
  -- The last word on overselling, under the row lock in lib/ticket-holds.ts. bigint: no overflow before the compare.
  CONSTRAINT "ticket_types_not_oversold" CHECK ("sold"::bigint + "held" <= "quantity"),
  CONSTRAINT "ticket_types_max_per_order_range" CHECK ("max_per_order" BETWEEN 1 AND 100),
  CONSTRAINT "ticket_types_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "ticket_types_sale_window_order" CHECK ("sale_starts_at" IS NULL OR "sale_ends_at" IS NULL OR "sale_starts_at" < "sale_ends_at")
);
CREATE INDEX "ticket_types_event_id_sort_idx" ON "ticket_types"("event_id", "sort");
CREATE UNIQUE INDEX "ticket_types_id_event_id_key" ON "ticket_types"("id", "event_id");

CREATE TABLE "ticket_orders" (
  "id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "buyer_id" TEXT NOT NULL,
  "status" "ticket_order_status" NOT NULL DEFAULT 'pending',
  "currency" TEXT NOT NULL,
  "subtotal_minor" INTEGER NOT NULL,
  "service_fee_minor" INTEGER NOT NULL,
  "service_fee_tax_minor" INTEGER NOT NULL,
  "processing_fee_minor" INTEGER NOT NULL,
  "total_minor" INTEGER NOT NULL,
  "fees_absorbed" BOOLEAN NOT NULL,
  "fee_breakdown" JSONB NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'razorpay',
  "provider_order_ref" TEXT,
  "provider_payment_ref" TEXT,
  "hold_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "paid_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ticket_orders_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ticket_orders_amounts_non_negative" CHECK (
    "subtotal_minor" >= 0 AND "service_fee_minor" >= 0 AND "service_fee_tax_minor" >= 0
    AND "processing_fee_minor" >= 0 AND "total_minor" >= 0
  ),
  -- The buyer is charged the subtotal, plus the fees unless the organiser absorbs them. bigint: no overflow.
  CONSTRAINT "ticket_orders_total_is_its_parts" CHECK (
    "total_minor"::bigint = "subtotal_minor"::bigint + CASE WHEN "fees_absorbed" THEN 0
      ELSE "service_fee_minor"::bigint + "service_fee_tax_minor" + "processing_fee_minor" END
  ),
  -- Paid only on the provider's word, and a refund was paid first.
  CONSTRAINT "ticket_orders_paid_has_payment_ref" CHECK (
    "status" NOT IN ('paid', 'refunded') OR ("provider_payment_ref" IS NOT NULL AND "paid_at" IS NOT NULL)
  ),
  CONSTRAINT "ticket_orders_fee_breakdown_object" CHECK (jsonb_typeof("fee_breakdown") = 'object')
);
CREATE INDEX "ticket_orders_event_id_status_idx" ON "ticket_orders"("event_id", "status");
CREATE INDEX "ticket_orders_buyer_id_created_at_idx" ON "ticket_orders"("buyer_id", "created_at");
CREATE UNIQUE INDEX "ticket_orders_provider_provider_order_ref_key" ON "ticket_orders"("provider", "provider_order_ref");
CREATE UNIQUE INDEX "ticket_orders_provider_provider_payment_ref_key" ON "ticket_orders"("provider", "provider_payment_ref");
CREATE UNIQUE INDEX "ticket_orders_id_event_id_key" ON "ticket_orders"("id", "event_id");
-- Partial, so migration SQL only: what the hold sweeper (releaseExpiredHolds) reads.
CREATE INDEX "ticket_orders_pending_expiry" ON "ticket_orders"("hold_expires_at") WHERE "status" = 'pending';

CREATE TABLE "ticket_order_lines" (
  "order_id" UUID NOT NULL,
  "ticket_type_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price_minor" INTEGER NOT NULL,
  CONSTRAINT "ticket_order_lines_pkey" PRIMARY KEY ("order_id", "ticket_type_id"),
  CONSTRAINT "ticket_order_lines_quantity_positive" CHECK ("quantity" >= 1),
  CONSTRAINT "ticket_order_lines_price_non_negative" CHECK ("unit_price_minor" >= 0)
);
CREATE INDEX "ticket_order_lines_ticket_type_id_idx" ON "ticket_order_lines"("ticket_type_id");

CREATE TABLE "tickets" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "ticket_type_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "holder_id" TEXT NOT NULL,
  "door_code" TEXT NOT NULL,
  "qr_secret" TEXT NOT NULL,
  "redeemed_at" TIMESTAMPTZ(6),
  "redeemed_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tickets_door_code_shape" CHECK ("door_code" ~ '^[A-Z0-9]{6}$'),
  -- 32 characters at least: a QR secret short enough to guess is not one.
  CONSTRAINT "tickets_qr_secret_length" CHECK (char_length("qr_secret") BETWEEN 32 AND 128),
  -- Who redeemed may be nulled (their account), when it was may not.
  CONSTRAINT "tickets_redeemer_needs_time" CHECK ("redeemed_by" IS NULL OR "redeemed_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "tickets_qr_secret_key" ON "tickets"("qr_secret");
CREATE UNIQUE INDEX "tickets_event_id_door_code_key" ON "tickets"("event_id", "door_code");
CREATE INDEX "tickets_order_id_idx" ON "tickets"("order_id");
CREATE INDEX "tickets_ticket_type_id_idx" ON "tickets"("ticket_type_id");
CREATE INDEX "tickets_holder_id_idx" ON "tickets"("holder_id");
CREATE INDEX "tickets_redeemed_by_idx" ON "tickets"("redeemed_by");

CREATE TABLE "legal_acceptances" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "document_key" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_acceptances_document_key_shape" CHECK ("document_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("document_key") <= 64),
  CONSTRAINT "legal_acceptances_version_shape" CHECK ("version" ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  CONSTRAINT "legal_acceptances_ip_length" CHECK ("ip" IS NULL OR char_length("ip") <= 45),
  CONSTRAINT "legal_acceptances_user_agent_length" CHECK ("user_agent" IS NULL OR char_length("user_agent") <= 512)
);
CREATE INDEX "legal_acceptances_org_id_document_key_accepted_at_idx" ON "legal_acceptances"("org_id", "document_key", "accepted_at" DESC);
CREATE INDEX "legal_acceptances_user_id_idx" ON "legal_acceptances"("user_id");

-- Append-only: an acceptance is evidence. A mistaken one is superseded by a new row, never edited.
-- Its foreign keys are RESTRICT, so nothing upstream cascades into it either.
CREATE FUNCTION legal_acceptances_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legal_acceptances is append-only: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER "legal_acceptances_append_only" BEFORE UPDATE OR DELETE ON "legal_acceptances"
  FOR EACH ROW EXECUTE FUNCTION legal_acceptances_refuse_change();
CREATE TRIGGER "legal_acceptances_no_truncate" BEFORE TRUNCATE ON "legal_acceptances"
  FOR EACH STATEMENT EXECUTE FUNCTION legal_acceptances_refuse_change();

ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_order_lines" ADD CONSTRAINT "ticket_order_lines_order_id_event_id_fkey" FOREIGN KEY ("order_id", "event_id") REFERENCES "ticket_orders"("id", "event_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_order_lines" ADD CONSTRAINT "ticket_order_lines_ticket_type_id_event_id_fkey" FOREIGN KEY ("ticket_type_id", "event_id") REFERENCES "ticket_types"("id", "event_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_event_id_fkey" FOREIGN KEY ("order_id", "event_id") REFERENCES "ticket_orders"("id", "event_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_type_id_event_id_fkey" FOREIGN KEY ("ticket_type_id", "event_id") REFERENCES "ticket_types"("id", "event_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_holder_id_fkey" FOREIGN KEY ("holder_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_redeemed_by_fkey" FOREIGN KEY ("redeemed_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
