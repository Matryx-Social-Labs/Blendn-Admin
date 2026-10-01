import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { isUuid } from "@/lib/api-input"
import { claimVenueWhere } from "@/lib/curation"
import { db } from "@/lib/db"
import { venueTypeLabel } from "@/lib/venue-types"

import { VenueClaimForm } from "./claim-form"

export const dynamic = "force-dynamic"

/**
 * "This place is mine" — for somebody with no account.
 *
 * Every venue is live from day one, and the founders seed most of them, so the
 * person who runs a place usually meets its listing (in the app, or in an
 * email from us) before they have a host account. `/dashboard/venues/[id]/claim`
 * needs a signed-in venue owner, and the dashboard refuses attendees, so an
 * app user tapping "Own this place? Claim it" had nowhere to land (F13 in the
 * test plan). This page is that landing.
 *
 * ## Public, on purpose
 *
 * The same reasoning as `/claim/[eventId]`: `middleware.ts` does not match
 * `/claim/*`, because a sign-in in front of it would be a signup wall in front
 * of the signup funnel. What makes the unauthenticated write defensible is that
 * it decides nothing. The claim waits for a person, and approving it still
 * needs the application approved, because that is what creates the
 * organisation the venue is handed to.
 *
 * The session is not read. An account holder claims from the dashboard, with
 * documents, and is pointed there.
 */
export default async function ClaimVenuePage({
  params,
}: {
  params: Promise<{ venueId: string }>
}) {
  const { venueId } = await params
  // venues.id is a UUID column: anything else is a missing venue, not a 500.
  if (!isUuid(venueId)) notFound()

  const venue = await db.venues.findUnique({
    where: claimVenueWhere(venueId),
    select: { id: true, name: true, venue_type: true, address: true, city: true, owner_org_id: true },
  })
  if (!venue) notFound()

  const where = [venue.address, venue.city].filter(Boolean).join(" · ")

  return (
    <main className="flex min-h-screen items-start justify-center px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-tight">Is this your place?</h1>
          <p className="text-[0.875rem] leading-6 text-muted-foreground">
            Blend&rsquo;n lists places in {venue.city ?? "the city"} so people can find them and meet
            there. If you run {venue.name}, take it over: once a person checks it is yours, you manage
            the venue, its check-in area and the events held there.
          </p>
        </div>

        <Card className="flex flex-col gap-2 rounded-xl p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold">{venue.name}</h2>
            {venue.venue_type ? <Badge variant="secondary">{venueTypeLabel(venue.venue_type)}</Badge> : null}
          </div>
          {where ? <p className="text-[0.8125rem] text-muted-foreground">{where}</p> : null}
          <p className="text-[0.75rem] text-faint-foreground">
            {venue.owner_org_id ? "Managed on Blend’n by its owner." : "Added by Blend’n. Nobody has claimed it yet."}
          </p>
        </Card>

        {venue.owner_org_id ? (
          /*
           * A fact about the place, not an error about the person. A dispute
           * needs an account and documents, so it is not offered here.
           */
          <Card className="flex flex-col gap-2 rounded-xl p-5">
            <p className="text-[0.875rem] font-medium">This place already has an owner on Blend&rsquo;n.</p>
            <p className="text-[0.8125rem] leading-6 text-muted-foreground">
              Somebody showed it was theirs and we handed it over. If that should have been you,
              reply to whoever sent you this link, or{" "}
              <Link href="/login" className="underline underline-offset-4 hover:text-foreground">
                sign in to a venue account
              </Link>{" "}
              and dispute it from your dashboard.
            </p>
          </Card>
        ) : (
          <VenueClaimForm venueId={venue.id} venueName={venue.name} />
        )}
      </div>
    </main>
  )
}
