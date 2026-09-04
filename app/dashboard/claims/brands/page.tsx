import { redirect } from "next/navigation"

import { SponsorClaimQueue } from "@/components/sponsor-claim-queue"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { getSponsorClaimQueue } from "@/lib/sponsor-claim-actions"

import { ClaimSwitch } from "../claim-switch"

export const dynamic = "force-dynamic"

/**
 * The brand half of the claim queue.
 *
 * Moved from `/dashboard/sponsor-claims`, which now redirects here, exactly as
 * venue claims moved before it. Three queues asked one question — somebody
 * wants ownership of something, and approving hands it over — and were three
 * screens only because they were built at three different times.
 *
 * The queue itself is unchanged. This is an IA change, not a behaviour one, and
 * mixing the two would make the diff unreviewable.
 */
export default async function BrandClaimsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const [claims, eventCount, venueCount] = await Promise.all([
    getSponsorClaimQueue(),
    db.event_claims.count({ where: { status: "pending" } }),
    db.venue_claims.count({ where: { status: "pending" } }),
  ])

  return (
    <div className="flex flex-col gap-5">
      <ClaimSwitch
        active="brands"
        eventCount={eventCount}
        venueCount={venueCount}
        brandCount={claims.length}
      />
      {/* What approving does NOT grant. The header covers the handover; this is
          the part it deliberately withholds. */}
      <p className="max-w-2xl text-[0.8125rem] leading-6 text-muted-foreground">
        Approving does not grant the right to place a sponsored message — that is the
        sponsoring grant on the organisation, set separately.
      </p>
      <SponsorClaimQueue claims={claims} />
    </div>
  )
}
