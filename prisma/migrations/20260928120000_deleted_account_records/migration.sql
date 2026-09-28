-- IT (Intermediary Guidelines) Rules 2021, r.3(1)(h): registration information
-- is kept for 180 days after an account is deleted, then purged. See
-- `deleted_account_records` in schema.prisma and lib/deleted-account-records.ts.
--
-- Hand-written: `migrate dev` against this schema also emits unrelated drift
-- that is not this change's to make.
--
-- No foreign key on purpose: nothing may cascade a record away before its
-- purge date, and `user_id` names a row that has already been anonymised.

CREATE TABLE "deleted_account_records" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "date_of_birth" DATE,
    "account_created_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL,
    "sign_up_method" TEXT NOT NULL,
    "purge_after" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deleted_account_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deleted_account_records_purge_after_idx" ON "deleted_account_records"("purge_after");
