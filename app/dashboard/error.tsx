"use client"

import { IconAlertTriangle } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"

/**
 * The dashboard's error boundary — one file, every route below it.
 *
 * ## What it replaces
 *
 * There was no boundary between a dashboard page and `app/global-error.tsx`,
 * and `global-error` replaces the **entire root layout**. So any throw on any
 * of 38 pages took the sidebar, the header and the nav with it and left a bare
 * apology on a blank page. Driving `/dashboard/users` as an organiser is what
 * showed it: a correct authorization refusal cost the whole application shell.
 *
 * Measured after this landed, with that page's gate deliberately broken again:
 * the nav survives and the failure stays in the content area.
 *
 * ## It reports a fault, and only a fault
 *
 * An earlier version of this — and the two route-level boundaries it replaces —
 * branched on `error.message` to tell "not your queue" from "it broke". That
 * branch could never run, for two independent reasons, and it is worth writing
 * both down because each alone would have been enough:
 *
 *   1. **Every page gates before it fetches**, so a non-admin is redirected and
 *      never reaches the throw. `/dashboard/users` was the one exception, and
 *      it was a bug — fixed by moving its gate above the `Promise.all`.
 *   2. **Next redacts Server Component error messages in production.** The
 *      client receives a generic string; only `digest` survives. So the branch
 *      worked in development and silently could not in production, which is the
 *      worst shape a conditional can have.
 *
 * A refusal is a redirect. This is for the database blip, and it says so.
 *
 * ## Why `retry` and not `reset`
 *
 * `reset()` is `setState({ error: null })` and nothing else, so the children
 * re-render from the RSC payload already in hand — which, for a failure that
 * happened on the server, reproduces it instantly and makes the button look
 * broken. `retry()` calls `router.refresh()` first. Next 16 passes both, and
 * the docs say to use `retry()` in most cases; this is one of them.
 */
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6">
      <IconAlertTriangle className="size-5 text-destructive" />
      <h2 className="text-sm font-bold">That page did not load</h2>
      <p className="max-w-prose text-[0.8125rem] leading-6 text-muted-foreground">
        Nothing was changed. Try again — if it keeps happening, quote the reference below.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={retry}>
          Try again
        </Button>
        {/*
         * The digest is the only thing that correlates this screen to a server
         * log line, and it is the only detail Next does not redact. It matters
         * more than usual here: production has no `NEXT_PUBLIC_SENTRY_DSN`, so
         * the deploy log is the only place the stack exists.
         */}
        {error.digest ? (
          <code className="text-[0.6875rem] text-faint-foreground">{error.digest}</code>
        ) : null}
      </div>
    </div>
  )
}
