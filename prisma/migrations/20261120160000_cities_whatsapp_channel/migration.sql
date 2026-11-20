-- A city's WhatsApp Channel (Flow 9 A, ruling 7): Notification settings shows a "Your city" row that opens it, for a
-- city that has one. Ops creates the channels and sets the URL; India's cities only today, which is data, not a rule here
-- (code on the city path names no country). Null is no row.
-- Additive: a nullable column with no default (no rewrite) and a CHECK on its shape, so the app only ever opens an
-- https WhatsApp channel link. Wrapped, because `migrate deploy` is not transactional; `cities` is a small table.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "cities" ADD COLUMN "whatsapp_channel_url" TEXT;
ALTER TABLE "cities"
  ADD CONSTRAINT "cities_whatsapp_channel_url_shape"
  CHECK ("whatsapp_channel_url" IS NULL OR "whatsapp_channel_url" ~ '^https://(www\.)?whatsapp\.com/channel/[A-Za-z0-9]{10,64}$');

COMMIT;
