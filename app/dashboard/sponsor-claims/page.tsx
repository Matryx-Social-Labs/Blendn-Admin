import { redirect } from "next/navigation"

import { SponsorClaimQueue } from "@/components/sponsor-claim-queue"
import { getAuth } from "@/lib/auth"
import { getSponsorClaimQueue } from "@/lib/sponsor-claim-actions"

export const dynamic = "force-dynamic"

export default async function SponsorClaimsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const claims = await getSponsorClaimQueue()

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="max-w-2xl text-[0.8125rem] leading-6 text-muted-foreground">
          Oldest first. Approving hands over the brand name, the logo shown beside
          every sponsored message, and the reporting on placements other people
          set up. It does not grant the right to place a sponsored message — that
          is the sponsoring grant on the organisation, set separately.
        </p>
      </div>
      <SponsorClaimQueue claims={claims} />
    </div>
  )
}
