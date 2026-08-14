-- Whether `orientation` is shown to people who can already see who you are.
--
-- `DEFAULT false` and NOT NULL: every existing row keeps today's behaviour,
-- which is that orientation reaches nobody. Special-category data under GDPR
-- Article 9 needs explicit consent, and backfilling anything other than false
-- would be inventing consent for every account that already exists.
ALTER TABLE "profiles" ADD COLUMN "show_orientation" BOOLEAN NOT NULL DEFAULT false;
