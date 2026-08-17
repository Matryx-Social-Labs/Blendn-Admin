import { redirect } from "next/navigation"

import { CreativeQueue } from "@/components/creative-queue"
import { getAuth } from "@/lib/auth"
import { getCreativeQueue } from "@/lib/creative-review-actions"

export const dynamic = "force-dynamic"

export default async function CreativeReviewPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const rows = await getCreativeQueue()

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-2xl text-[0.8125rem] leading-6 text-muted-foreground">
        Nothing sponsored reaches a room unread. Approving does not switch a
        campaign on — the organiser decides when it runs. Rejecting stops it, so a
        campaign already sending an older revision goes quiet immediately.
      </p>
      <CreativeQueue rows={rows} />
    </div>
  )
}
