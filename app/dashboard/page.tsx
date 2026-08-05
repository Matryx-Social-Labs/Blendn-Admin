import { getAuth } from "@/lib/auth"
import { OverviewAdmin } from "@/components/dashboard/overview-admin"
import { OverviewOrganizer } from "@/components/dashboard/overview-organizer"
import { OverviewVenue } from "@/components/dashboard/overview-venue"
import type { DashboardRole } from "@/lib/dashboard-types"

import { getDashboardOverview } from "./actions"

export const dynamic = "force-dynamic"

export default async function Page() {
  const session = await getAuth()
  const role = session?.user?.role as DashboardRole
  const userId = role === "app_admin" ? undefined : session?.user?.id
  const overview = await getDashboardOverview(role, userId)

  // Narrowed on the discriminant rather than on `role`, so the three overviews
  // cannot be handed a payload built for a different one.
  if (overview.role === "app_admin") return <OverviewAdmin data={overview} />
  if (overview.role === "venue_owner") return <OverviewVenue data={overview} />
  return <OverviewOrganizer data={overview} />
}
