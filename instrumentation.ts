import * as Sentry from "@sentry/nextjs"

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

/*
 * Errors Next.js catches itself -- a route handler that throws, a server
 * component, a server action -- reach Sentry only through this hook (Next's
 * instrumentation docs: "track server errors to any custom observability
 * provider"). It was an empty function with a comment saying the SDK captures
 * them automatically, so a production 500 showed up only in Railway's log
 * (SCRUM-649). Sentry's own hook is the documented value; the `beforeSend`
 * scrub in sentry.server.config.ts still runs on what it captures.
 */
export const onRequestError = Sentry.captureRequestError
