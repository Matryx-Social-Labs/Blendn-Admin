-- Offer pushes need an explicit yes (SCRUM-628, App Store guideline 4.5.4).
--
-- A venue's offer is a promotion. Its push went to everybody in the audience,
-- on by default, with no consent asked in the app. `offer_push_consent_at` is
-- the yes and when it was given; null is no. Nobody has one until they give
-- it, existing accounts included: the column is added with no default, so
-- every row starts at null. lib/push-notifications.ts sends an offer push
-- only to a profile with one; the offer itself (bell line, Passes & offers)
-- still arrives. "Offers from places" (`offers_from_places`) is unchanged: it
-- is the switch for offers at all, not for their push.
--
-- Additive and nullable (no default): a catalogue change, no rewrite. Rolling
-- back is a NEW forward migration dropping the column; a rollback of the CODE
-- alone is safe, since older code reads no such column. Its own transaction,
-- with lock_timeout (memory: prisma-migrate-deploy-not-transactional).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "profiles" ADD COLUMN "offer_push_consent_at" TIMESTAMPTZ(6);

COMMIT;
