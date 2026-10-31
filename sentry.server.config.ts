import * as Sentry from "@sentry/nextjs"
import { beforeSend, IGNORED_ERRORS, SENTRY_DATA_COLLECTION } from "@/lib/sentry-scrub"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Unset, the SDK reports "production" from staging too.
  environment: process.env.RAILWAY_ENVIRONMENT_NAME,
  tracesSampleRate: 0.1,
  dataCollection: SENTRY_DATA_COLLECTION,
  ignoreErrors: IGNORED_ERRORS,
  beforeSend,
})
