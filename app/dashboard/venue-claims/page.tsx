import { redirect } from "next/navigation"

import { VenueClaimQueue } from "@/components/venue-claim-queue"
import { getAuth } from "@/lib/auth"
import { getVenueClaimQueue } from "@/lib/venue-claim-actions"

export const dynamic = "force-dynamic"

export default async function VenueClaimsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const claims = await getVenueClaimQueue()

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--text-h1)] font-bold">Venue claims</h1>
        <p className="text-[0.8125rem] text-muted-foreground">
          Oldest first. Approving grants the claimant the events other organisers hold at that
          venue — the chatroom, the attendee count and the feedback. Organisers can unlink, so a
          wrong approval is recoverable.
        </p>
      </div>
      <VenueClaimQueue claims={claims} />
    </div>
  )
}
