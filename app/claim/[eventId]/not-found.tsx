import Link from "next/link"

import { Card } from "@/components/ui/card"

/**
 * A claim link that points at nothing.
 *
 * Worth its own file rather than Next's default 404, because of who follows
 * these links: an organiser we cold-emailed, or somebody who tapped through
 * from the app. They have no account and no reason to trust us yet, and a bare
 * "404 | This page could not be found" from a stranger asking about their
 * event reads like a scam.
 *
 * The two real causes are a deleted event and a mistyped link, and both are
 * ours to apologise for rather than theirs to debug.
 */
export default function ClaimNotFound() {
  return (
    <main className="flex min-h-screen items-start justify-center px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight">We cannot find that event</h1>
        <Card className="flex flex-col gap-2 rounded-xl p-5">
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            The link may be out of date, or the listing may have been taken down. Nothing has
            happened to anything you own — this page only ever asks a question.
          </p>
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            If somebody sent you this about an event you run, reply to them and we will sort it out.
          </p>
        </Card>
        <Link href="/" className="text-[0.8125rem] text-muted-foreground hover:text-foreground">
          Blend&rsquo;n
        </Link>
      </div>
    </main>
  )
}
