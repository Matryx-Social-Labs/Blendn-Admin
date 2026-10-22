-- Sponsor payment links (step 17, plan v2 §9.2): a purchase may be a Razorpay
-- Payment Link for one placement charge.
--
-- Its own migration because Postgres will not use an enum value in the
-- transaction that added it, and the next migration's CHECKs name it.
-- Rolling back: a value cannot be dropped from an enum in place; a NEW
-- forward migration recreates the type without it, once no row uses it.
ALTER TYPE "billing_checkout_kind" ADD VALUE IF NOT EXISTS 'payment_link';
