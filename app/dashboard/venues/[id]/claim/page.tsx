import { notFound, redirect } from "next/navigation"

import { VenueClaimForm } from "@/components/venue-claim-form"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { venueTypeLabel } from "@/lib/venue-types"

export const dynamic = "force-dynamic"

export default async function ClaimVenuePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  // Same rule as `fileVenueClaim`: only a venue owner can request operational
  // control over other people's events.
  if (session.user.role !== "venue_owner" && session.user.role !== "app_admin") {
    redirect(`/dashboard/venues/${id}`)
  }

  const venue = await db.venues.findUnique({
    where: { id, deleted_at: null },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      venue_type: true,
      owner_org_id: true,
      owner_org: { select: { display_name: true } },
      _count: { select: { events: true } },
    },
  })
  if (!venue) notFound()

  const membership = await db.organisation_members.findFirst({
    where: { user_id: session.user.id },
    select: { org_id: true },
  })
  if (venue.owner_org_id && venue.owner_org_id === membership?.org_id) {
    redirect(`/dashboard/venues/${id}`)
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--text-h1)] font-bold">Claim {venue.name}</h1>
        <p className="text-[0.8125rem] text-muted-foreground">
          {venueTypeLabel(venue.venue_type)}
          {[venue.address, venue.city].filter(Boolean).length
            ? ` · ${[venue.address, venue.city].filter(Boolean).join(", ")}`
            : ""}
        </p>
      </div>

      <VenueClaimForm
        venueId={venue.id}
        venueName={venue.name}
        isDispute={venue.owner_org_id !== null}
        currentOwnerName={venue.owner_org?.display_name ?? null}
        hostedEvents={venue._count.events}
      />
    </div>
  )
}
