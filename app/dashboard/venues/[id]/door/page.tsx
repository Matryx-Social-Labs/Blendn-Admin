import { notFound, redirect } from "next/navigation"

import { Panel } from "@/components/dashboard/kit"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { activeMembership } from "@/lib/org-membership"
import { mayRedeemAtVenue } from "@/lib/rbac"
import { DoorRedeem } from "./door-redeem"

export const dynamic = "force-dynamic"
export const metadata = { title: "Redeem a pass" }

/**
 * The door (step 12): staff redeem a regular's pass.
 *
 * The person opens the offer in the app; the pass shows six characters that
 * change every 30 seconds. Staff type them here and tap "Redeemed". The
 * server checks the code, redeems it once and answers with the offer's words
 * — never who: the person is standing in front of them (lib/offer-actions.ts).
 *
 * For the venue's own staff: active members of its organisation. Everyone
 * else is sent back to their venues; the action refuses them anyway.
 */
export default async function DoorPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  const { id } = await params

  const venue = await db.venues.findFirst({
    where: { id, deleted_at: null },
    select: { id: true, name: true, owner_org_id: true },
  })
  if (!venue) notFound()
  const member =
    venue.owner_org_id && mayRedeemAtVenue(session.user.role)
      ? await db.organisation_members.findFirst({
          where: { user_id: session.user.id, org_id: venue.owner_org_id, ...activeMembership },
          select: { id: true },
        })
      : null
  if (!member) redirect("/dashboard/venues")

  return (
    <div className="mx-auto flex w-full max-w-[420px] flex-col gap-5">
      <Panel title={venue.name} hint="the door">
        <p className="text-[0.8125rem] text-muted-foreground">
          Ask them to open the offer in Blendn. Type the six characters on their pass — they change every 30 seconds — and tap
          Redeemed.
        </p>
        <DoorRedeem venueId={venue.id} />
      </Panel>
    </div>
  )
}
