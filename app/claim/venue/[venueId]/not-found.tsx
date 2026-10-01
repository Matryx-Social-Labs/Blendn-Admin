import Link from "next/link"

import { Card } from "@/components/ui/card"

/**
 * A venue claim link that points at nothing: a mistyped link, or a place we
 * archived. Its own page for the reason `/claim/[eventId]` has one — the person
 * following it has no account and no reason to trust us yet.
 */
export default function VenueClaimNotFound() {
  return (
    <main className="flex min-h-screen items-start justify-center px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight">We cannot find that place</h1>
        <Card className="flex flex-col gap-2 rounded-xl p-5">
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            The link may be out of date, or the listing may have been taken down. Nothing has
            happened to anything you own — this page only ever asks a question.
          </p>
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            If somebody sent you this about a place you run, reply to them and we will sort it out.
          </p>
        </Card>
        <Link href="/" className="text-[0.8125rem] text-muted-foreground hover:text-foreground">
          Blend&rsquo;n
        </Link>
      </div>
    </main>
  )
}
