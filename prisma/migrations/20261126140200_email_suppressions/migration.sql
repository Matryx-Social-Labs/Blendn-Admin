-- Addresses Blend'n must not mail (SCRUM-1280, launch gate 14). `bounce` and `complaint` come from the Resend
-- webhook (app/api/webhooks/resend); `unsubscribe` from the lifecycle mails' List-Unsubscribe (growth 04b). Which
-- sends each one stops is lib/email.ts `blocks`. The address is stored trimmed and lower-cased, as sign-in stores it.
-- Additive: a new table nothing reads yet, so its CHECK and key cost no scan.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "email_suppressions" (
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("email"),
    CONSTRAINT "email_suppressions_reason_known" CHECK ("reason" IN ('bounce', 'complaint', 'unsubscribe'))
);

COMMIT;
