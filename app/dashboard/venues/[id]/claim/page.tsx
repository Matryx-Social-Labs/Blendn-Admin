import { notFound, redirect } from "next/navigation"

import { VenueClaimForm } from "@/components/venue-claim-form"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { venueTypeLabel } from "@/lib/venue-types"
import { activeMembership } from "@/lib/org-membership"

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

  // Any of the person's organisations, not the first Postgres returned: a
  // two-org member whose second org owns the venue was offered a claim on
  // their own venue (SCRUM-148).
  const memberships = await db.organisation_members.findMany({
    where: { user_id: session.user.id, ...activeMembership },
    select: { org_id: true },
  })
  if (venue.owner_org_id && memberships.some((m) => m.org_id === venue.owner_org_id)) {
    redirect(`/dashboard/venues/${id}`)
  }

  return (
    <div className="flex flex-col gap-5">
      {/* h2: the site header owns the page's only h1. */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="text-[length:var(--text-h2)] font-bold">{venue.name}</h2>
        <span className="text-[0.8125rem] text-muted-foreground">
          {venueTypeLabel(venue.venue_type)}
          {[venue.address, venue.city].filter(Boolean).length
            ? ` · ${[venue.address, venue.city].filter(Boolean).join(", ")}`
            : ""}
        </span>
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
