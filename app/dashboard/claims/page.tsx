import { redirect } from "next/navigation"

import { CLAIM_PAGE } from "@/lib/curation"
import { getEventClaimQueue } from "@/lib/event-claim-actions"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"

import { ClaimSwitch } from "./claim-switch"
import { EventClaimsTable } from "./event-claims-table"

export const dynamic = "force-dynamic"

/**
 * Somebody wants ownership of something. Decide.
 *
 * Events and venues are two tables and one job — see `ClaimSwitch`. This is the
 * events half, and it is the default because a curated event with a claimant is
 * the acquisition funnel working, which is more time-sensitive than a venue
 * claim: the claimant is an organiser deciding whether this platform is worth
 * their time.
 */
export default async function ClaimsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const [{ rows, total }, venueCount, brandCount] = await Promise.all([
    getEventClaimQueue(),
    db.venue_claims.count({ where: { status: "pending" } }),
    db.sponsor_claims.count({ where: { status: "pending" } }),
  ])

  return (
    <div className="flex flex-col gap-5">
      <ClaimSwitch
        active="events"
        eventCount={total}
        venueCount={venueCount}
        brandCount={brandCount}
      />
      {/* h2, not h1: `components/site-header.tsx` owns the page's only h1. */}
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-bold">Event claims</h2>
        <p className="max-w-2xl text-[0.8125rem] leading-6 text-muted-foreground">
          Oldest first, because age is the SLA. Approving hands over the attendee
          list and cannot be undone — the flags are evidence to weigh, never a
          verdict.
        </p>
      </div>
      {total > rows.length ? (
        // A capped queue that does not say so reads as "this is all of them".
        <p className="text-[0.75rem] text-muted-foreground">
          Showing the {CLAIM_PAGE} longest-waiting of {total}.
        </p>
      ) : null}
      <EventClaimsTable rows={rows} />
    </div>
  )
}
