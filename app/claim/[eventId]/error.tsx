"use client"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

/**
 * The public half of the funnel failing.
 *
 * The dashboard's boundaries distinguish "not your queue" from a transient
 * failure, because both are plausible there. Here only one is: this page takes
 * no session and refuses nobody, so anything that throws is ours — a database
 * blip, nothing else. So it says so plainly and offers the retry, rather than
 * showing a stranger a stack trace while asking them to trust us with their
 * event.
 */
export default function ClaimError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-screen items-start justify-center px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight">That did not load</h1>
        <Card className="flex flex-col items-start gap-3 rounded-xl p-5">
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            Our problem, not yours — nothing you did caused it and nothing was filed. Try again, and
            if it keeps happening reply to whoever sent you the link.
          </p>
          <Button onClick={reset} variant="outline" size="sm">
            Try again
          </Button>
        </Card>
      </div>
    </main>
  )
}
