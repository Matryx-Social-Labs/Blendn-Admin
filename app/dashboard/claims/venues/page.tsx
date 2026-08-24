import { redirect } from "next/navigation"

import { VenueClaimQueue } from "@/components/venue-claim-queue"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { getVenueClaimQueue } from "@/lib/venue-claim-actions"

import { ClaimSwitch } from "../claim-switch"

export const dynamic = "force-dynamic"

/**
 * The venue half of the claim queue.
 *
 * Moved from `/dashboard/venue-claims`, which now redirects here. The queue
 * itself is unchanged — this is an IA change, not a behaviour one, and mixing
 * the two would make the diff unreviewable.
 */
export default async function VenueClaimsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const [claims, eventCount] = await Promise.all([
    getVenueClaimQueue(),
    db.event_claims.count({ where: { status: "pending" } }),
  ])

  return (
    <div className="flex flex-col gap-5">
      <ClaimSwitch active="venues" eventCount={eventCount} venueCount={claims.length} />
      <VenueClaimQueue claims={claims} />
    </div>
  )
}
