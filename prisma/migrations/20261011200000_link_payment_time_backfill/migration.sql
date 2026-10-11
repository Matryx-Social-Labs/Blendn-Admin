-- Link payments recorded before #673 (SCRUM-606) carry the LINK's creation
-- time as when they were paid: `payment_link.paid` is stamped with it, and the
-- webhook wrote that stamp to `billing_payments.captured_at` and the charge's
-- `placement_charges.settled_at`. Each applied delivery is kept (redacted) in
-- `payment_events`, with the payment's own `created_at`; this puts both back
-- to it (review L6).
--
-- Only rows still holding exactly that delivery's stamp, and only where the
-- payment came after it, are touched: a re-run, a database with no link
-- payments (production today, a fresh build), or a row fixed by hand changes
-- nothing. A value that is not a JSON number is skipped, never cast, so a
-- stray payload cannot fail the deploy. No schema change; rolling back the
-- code alone is safe, and there is nothing to roll back here.
--
-- `prisma migrate deploy` runs a file statement by statement (step 17
-- review), so this file is its own transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';

WITH paid AS MATERIALIZED (
  SELECT pe.payload #>> '{payload,payment,entity,id}' AS payment_id,
         to_timestamp((pe.payload -> 'created_at')::numeric) AS stamped_at,
         to_timestamp((pe.payload #> '{payload,payment,entity,created_at}')::numeric) AS paid_at
    FROM payment_events pe
   WHERE pe.provider = 'razorpay'
     AND pe.type = 'payment_link.paid'
     AND pe.processed_at IS NOT NULL
     AND jsonb_typeof(pe.payload -> 'created_at') = 'number'
     AND jsonb_typeof(pe.payload #> '{payload,payment,entity,created_at}') = 'number'
)
UPDATE billing_payments bp
   SET captured_at = paid.paid_at
  FROM paid
 WHERE bp.provider = 'razorpay'
   AND bp.provider_payment_id = paid.payment_id
   AND bp.captured_at = paid.stamped_at
   AND paid.paid_at > paid.stamped_at;

WITH paid AS MATERIALIZED (
  SELECT pe.payload #>> '{payload,payment_link,entity,id}' AS link_id,
         to_timestamp((pe.payload -> 'created_at')::numeric) AS stamped_at,
         to_timestamp((pe.payload #> '{payload,payment,entity,created_at}')::numeric) AS paid_at
    FROM payment_events pe
   WHERE pe.provider = 'razorpay'
     AND pe.type = 'payment_link.paid'
     AND pe.processed_at IS NOT NULL
     AND jsonb_typeof(pe.payload -> 'created_at') = 'number'
     AND jsonb_typeof(pe.payload #> '{payload,payment,entity,created_at}') = 'number'
)
UPDATE placement_charges pc
   SET settled_at = paid.paid_at
  FROM paid
 WHERE pc.external_ref = paid.link_id
   AND pc.settled_at = paid.stamped_at
   AND paid.paid_at > paid.stamped_at;

COMMIT;
