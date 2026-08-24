import { redirect } from "next/navigation"

import { VenueCreateForm } from "@/components/venue-create-form"
import { getAuth } from "@/lib/auth"

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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        {/* h2, not h1: `components/site-header.tsx` owns the page's only h1. */}
        <h2 className="text-[length:var(--text-h1)] font-bold">Add a venue</h2>
        <p className="text-[0.8125rem] text-muted-foreground">
          {canOwn
            ? "It joins your venues straight away — you are describing your own place, so there is nothing to claim."
            : "Created unclaimed. A venue owner can claim it, and you decide."}
        </p>
      </div>
      <VenueCreateForm canOwn={canOwn} />
    </div>
  )
}
