-- SCRUM-1014, security review 6 (CRITICAL): a payout's own release floor, recorded when its order is paid
-- (holdFloor of the event as it was then) and never lowered. The release job releases at
-- GREATEST(release_floor, holdFloor(event now)), so moving an event's times earlier, even into the past, can
-- delay a payout but never bring it forward.
BEGIN;

ALTER TABLE "ticket_payouts" ADD COLUMN "release_floor" TIMESTAMPTZ(6);
UPDATE "ticket_payouts" p
   SET "release_floor" = GREATEST(e."start_time", e."end_time") + interval '3 days'
  FROM "ticket_orders" o JOIN "events" e ON e."id" = o."event_id"
 WHERE o."id" = p."order_id";
ALTER TABLE "ticket_payouts" ALTER COLUMN "release_floor" SET NOT NULL;

-- Only ever raised: a lowered floor is the premature release this column exists to refuse.
CREATE FUNCTION "ticket_payouts_release_floor_only_up"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."release_floor" < OLD."release_floor" THEN
    RAISE EXCEPTION 'ticket_payouts.release_floor may only be raised (order %)', OLD."order_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ticket_payouts_release_floor_only_up" BEFORE UPDATE OF "release_floor" ON "ticket_payouts"
  FOR EACH ROW EXECUTE FUNCTION "ticket_payouts_release_floor_only_up"();

COMMIT;
