"use client"

import { IconAlertTriangle } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"

/**
 * What a reviewer sees when the queue cannot load.
 *
 * The read half of both screens throws on a non-admin and on a database blip,
 * and without this the user got Next's default error page — which says nothing
 * about which of those it was, and offers no way back.
 *
 * `reset()` re-runs the server component, so a transient failure costs one
 * click rather than a navigation.
 */
export default function QueueError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const notAuthorised = error.message.includes("Not authorised")

  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6">
      <IconAlertTriangle className="size-5 text-destructive" />
      <h2 className="text-sm font-bold">
        {notAuthorised ? "Not your queue" : "That queue did not load"}
      </h2>
      <p className="max-w-prose text-[0.8125rem] leading-6 text-muted-foreground">
        {notAuthorised
          ? "Claims and curation are platform-admin surfaces. If you think you should have access, somebody has to grant it."
          : "Nothing was changed. This is almost always a momentary database hiccup — try again, and if it persists the deploy logs will say why."}
      </p>
      {notAuthorised ? null : <Button size="sm" onClick={reset}>Try again</Button>}
    </div>
  )
}
