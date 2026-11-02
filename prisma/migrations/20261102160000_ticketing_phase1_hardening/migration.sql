-- Ticketing, phase 1 hardening (SCRUM-1010, epic SCRUM-1007): the database and security review of
-- 20261102120000_ticketing_phase1, which is not edited. Still behind `TICKETING`, still no routes.
--
-- No ticket, order or acceptance has a writer outside tests yet, so the data steps below are
-- defensive: they make every ADD CONSTRAINT safe on any database this has reached.
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Markets ----------------------------------------------------------------------------------------

-- Ascending slab thresholds were parseFeeSchedule's alone, and the schema comment said a CHECK held
-- them. Now one does. IMMUTABLE and over its argument only, so a CHECK may call it.
CREATE FUNCTION ticket_fee_slabs_ascending(thresholds INTEGER[]) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT NOT EXISTS (
      SELECT 1 FROM generate_subscripts(thresholds, 1) AS i
       WHERE i > 1 AND thresholds[i] <= thresholds[i - 1]
    )
  $$;

ALTER TABLE "markets"
  ADD CONSTRAINT "markets_ticket_fee_slabs_ascending" CHECK (ticket_fee_slabs_ascending("ticket_fee_slab_from")),
  -- A market that sells or links out charges at least one minor unit a paid ticket.
  ADD CONSTRAINT "markets_ticket_fee_min_when_selling" CHECK ("ticketing_mode" = 'off' OR "ticket_fee_min_minor" >= 1);

-- Events: who turned ticketing on decided the price rule, in the database, once ---------------------

CREATE TYPE "ticket_fee_rule" AS ENUM ('standard', 'pro', 'founding');

ALTER TABLE "events"
  ADD COLUMN "ticketing_enabled_at" TIMESTAMPTZ(6),
  ADD COLUMN "ticket_fee_rule" "ticket_fee_rule";

-- A native event from before this has no rule nobody chose. None exist (no writer has shipped);
-- one written by hand goes back to off and through enableTicketing like any other.
UPDATE "events" SET "ticketing_mode" = 'off' WHERE "ticketing_mode" = 'native';

ALTER TABLE "events"
  ADD CONSTRAINT "events_ticket_fee_rule_with_enabled_at" CHECK (("ticketing_enabled_at" IS NULL) = ("ticket_fee_rule" IS NULL)),
  ADD CONSTRAINT "events_ticketing_native_needs_enablement" CHECK ("ticketing_mode" <> 'native' OR "ticketing_enabled_at" IS NOT NULL);

-- Orders -----------------------------------------------------------------------------------------

-- Free tickets never make an order (ticketing-business-model.md §4.4): nothing to charge, nothing to hold.
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_total_positive" CHECK ("total_minor" > 0);

-- A line is part of a money record: deleting an order must not quietly take its lines with it.
ALTER TABLE "ticket_order_lines" DROP CONSTRAINT "ticket_order_lines_order_id_event_id_fkey";
ALTER TABLE "ticket_order_lines" ADD CONSTRAINT "ticket_order_lines_order_id_event_id_fkey"
  FOREIGN KEY ("order_id", "event_id") REFERENCES "ticket_orders"("id", "event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tickets ----------------------------------------------------------------------------------------

-- No QR secret is stored at all. A ticket's QR is `<id>.<HMAC-SHA256(TICKET_QR_KEY, id)>`, derived on
-- demand (lib/tickets.ts ticketQrPayload), so a reinstalled phone gets it back and a copy of this table
-- is not a copy of every pass. Dropping the column drops `tickets_qr_secret_length` and
-- `tickets_qr_secret_key` with it.
ALTER TABLE "tickets" DROP COLUMN "qr_secret";

-- Door codes from Crockford base32 less 0 O 1 I L U: 30 symbols nobody misreads at a door. Spelled
-- out, not as ranges, so the collation cannot widen it. NOT VALID: a code already issued stays
-- the holder's (there are none outside tests); every new one is held to it.
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_door_code_shape";
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_door_code_shape" CHECK ("door_code" ~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$') NOT VALID;

-- A ticket exists only for a paid order: written in the transaction that marks it paid (Phase 2).
-- FOR SHARE, so a refund cannot land between this read and the insert.
CREATE FUNCTION tickets_order_must_be_paid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ticket_orders WHERE id = NEW.order_id AND status = 'paid' FOR SHARE) THEN
    RAISE EXCEPTION 'tickets_order_must_be_paid: order % is not paid', NEW.order_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "tickets_order_must_be_paid" BEFORE INSERT OR UPDATE OF "order_id" ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION tickets_order_must_be_paid();

-- Legal acceptances --------------------------------------------------------------------------------
--
-- Append-only, so existing rows cannot be rewritten to fit: the new rules are NOT VALID, which is
-- every row from here on and none before (there are none outside tests).

ALTER TABLE "legal_acceptances" ADD COLUMN "document_sha256" TEXT;

ALTER TABLE "legal_acceptances"
  -- The exact text shown, so "version 0.1" can be proved to mean these words.
  ADD CONSTRAINT "legal_acceptances_document_sha256_shape" CHECK ("document_sha256" IS NOT NULL AND "document_sha256" ~ '^[0-9a-f]{64}$') NOT VALID,
  -- The network, never the address: /24 for IPv4, /48 for IPv6 (lib/legal-acceptance.ts truncatedIp).
  ADD CONSTRAINT "legal_acceptances_ip_truncated" CHECK (
    "ip" IS NULL
    OR "ip" ~ '^([0-9]{1,3}\.){3}0/24$'
    OR "ip" ~ '^[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::/48$'
  ) NOT VALID;

ALTER TABLE "legal_acceptances" DROP CONSTRAINT "legal_acceptances_user_agent_length";
ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_user_agent_length" CHECK ("user_agent" IS NULL OR char_length("user_agent") <= 200) NOT VALID;

COMMIT;
