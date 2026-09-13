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

  return <CreativeQueue rows={rows} />
}
