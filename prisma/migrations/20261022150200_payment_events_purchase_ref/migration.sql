-- `GET /me/plus` reports where a store subscription stands from the newest
-- RevenueCat delivery about that purchase. Without these the lookup scans every
-- delivery ever stored, on a route the paywall polls every 3 s.
--
-- Additive: two partial expression indexes. Rolling back is a NEW forward
-- migration that drops them; older code never reads them.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX "payment_events_rc_original_txn_idx"
  ON "payment_events" ((payload->'event'->>'original_transaction_id'))
  WHERE provider = 'revenuecat';
CREATE INDEX "payment_events_rc_txn_idx"
  ON "payment_events" ((payload->'event'->>'transaction_id'))
  WHERE provider = 'revenuecat';

COMMIT;
