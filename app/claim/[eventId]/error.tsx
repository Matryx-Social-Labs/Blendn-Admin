"use client"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

/**
 * The public half of the funnel failing.
 *
 * This page takes no session and refuses nobody, so anything that throws is
 * ours — a database blip, nothing else. It says so plainly and offers the
 * retry, rather than showing a stranger a stack trace while asking them to
 * trust us with their event.
 *
 * No branch on `error.message`, deliberately: Next redacts Server Component
 * error messages in production, so any conditional built on one works in
 * development and quietly cannot in production.
 */
export default function ClaimError({ retry }: { error: Error; retry: () => void }) {
  return (
    <main className="flex min-h-screen items-start justify-center px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight">That did not load</h1>
        <Card className="flex flex-col items-start gap-3 rounded-xl p-5">
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            Our problem, not yours — nothing you did caused it and nothing was filed. Try again, and
            if it keeps happening reply to whoever sent you the link.
          </p>
          <Button onClick={retry} variant="outline" size="sm">
            Try again
          </Button>
        </Card>
      </div>
    </main>
  )
}
