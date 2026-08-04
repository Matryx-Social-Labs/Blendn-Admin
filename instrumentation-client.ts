// Was sentry.client.config.ts. Next.js only picks up browser-side
// instrumentation from this filename under Turbopack, which Next 16 defaults
// to — the old name silently stops initialising Sentry in the browser there.
import * as Sentry from "@sentry/nextjs"
import { beforeSend, IGNORED_ERRORS } from "@/lib/sentry-scrub"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  ignoreErrors: IGNORED_ERRORS,
  beforeSend,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
})

// Required for navigation instrumentation under the instrumentation-client
// convention; without it router transitions are not traced.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
