import { notFound, redirect } from "next/navigation"

import { Panel } from "@/components/dashboard/kit"
import { PageHeader } from "@/components/dashboard/page-header"
import { VenueClaimForm } from "@/components/venue-claim-form"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { venueTypeLabel } from "@/lib/venue-types"
import { activeMembership } from "@/lib/org-membership"
import { realEventsWhere } from "@/lib/event-kind"

export const dynamic = "force-dynamic"

// Not the venue's name: a claimant is, by definition, not its owner, and the
// tab title is read before the page's own checks have run.
export const metadata = { title: "Claim a venue" }

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
      // What the owner hosted, not every row: the form calls it evidence in a
      // dispute, and QA Circle Venue read 32 while hosting 11 (SCRUM-312).
      _count: { select: { events: { where: { deleted_at: null, ...realEventsWhere } } } },
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
      {/* Owned header (`OWNED_HEADERS`): the venue being claimed, by name. */}
      <PageHeader
        title={venue.name}
        description={`${venueTypeLabel(venue.venue_type)}${
          [venue.address, venue.city].filter(Boolean).length
            ? ` · ${[venue.address, venue.city].filter(Boolean).join(", ")}`
            : ""
        }`}
        back={{ href: `/dashboard/venues`, label: "Venues" }}
      />

      <Panel
        title="Your claim"
        hint={`${venue._count.events} event${venue._count.events === 1 ? "" : "s"} held here · reviewed by a person`}
      >
        <VenueClaimForm
          venueId={venue.id}
          venueName={venue.name}
          isDispute={venue.owner_org_id !== null}
          currentOwnerName={venue.owner_org?.display_name ?? null}
          hostedEvents={venue._count.events}
        />
      </Panel>
    </div>
  )
}
