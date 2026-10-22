import { redirect } from "next/navigation"

import { Panel } from "@/components/dashboard/kit"
import { VenueCreateForm } from "@/components/venue-create-form"
import { getAuth } from "@/lib/auth"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/venues/new")

export const dynamic = "force-dynamic"

/**
 * The first venue write path this product has ever had.
 *
 * Organisers are excluded deliberately: owning a venue grants operational
 * control over other people's events held there, and an organiser has no claim
 * to that. They still get free-text venue names on events, which is what most
 * events need.
 */
export default async function NewVenuePage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const canOwn = session.user.role === "venue_owner"
  if (!canOwn && session.user.role !== "app_admin") redirect("/dashboard/venues")

  // The layout's header says "Add a venue" and what one is. Beside the form,
  // the other door: a place already on Blend'n is claimed, not added again.
  return (
    <div className="grid gap-5 @4xl/main:grid-cols-[minmax(0,1fr)_300px] @4xl/main:items-start">
      <Panel title="The place">
        <VenueCreateForm canOwn={canOwn} />
      </Panel>
      <Panel title="Already listed?">
        <p className="text-[0.8125rem] leading-5 text-muted-foreground">
          {canOwn
            ? "If your venue is already on Blend'n, claim it instead — that brings the events already held there with it. Place it on the map and the form shows what is listed there, with a claim button."
            : "Created unclaimed. A venue owner can claim it, and you decide."}
        </p>
        {canOwn ? (
          <p className="text-[0.8125rem] leading-5 text-muted-foreground">
            Adding it yourself makes it yours straight away: you are describing your own place, so there is nothing
            to claim.
          </p>
        ) : null}
      </Panel>
    </div>
  )
}
