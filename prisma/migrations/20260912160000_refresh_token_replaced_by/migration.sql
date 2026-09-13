-- A rotated refresh token remembers its successor, so a client that lost the
-- rotation response can present the old token once more and be re-issued
-- instead of signed out.
ALTER TABLE "mobile_refresh_tokens" ADD COLUMN "replaced_by" UUID;
