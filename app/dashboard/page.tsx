import { OverviewAdmin } from "@/components/dashboard/overview-admin"
import { OverviewOrganizer } from "@/components/dashboard/overview-organizer"
import { OverviewVenue } from "@/components/dashboard/overview-venue"
import { resolveRange } from "@/lib/date-range"

import { getDashboardOverview } from "./actions"

export const dynamic = "force-dynamic"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>
}) {
  // The header's date control writes these. Reading them here is what makes it
  // a control rather than decoration — the previous version of that space was a
  // chip showing today's date that nothing responded to.
  const range = resolveRange(await searchParams)
  // Role and identity are read from the session inside the action. Passing them
  // from here made them caller-controlled on what is really a POST endpoint.
  const overview = await getDashboardOverview(range)

  // Narrowed on the discriminant rather than on `role`, so the three overviews
  // cannot be handed a payload built for a different one.
  if (overview.role === "app_admin") return <OverviewAdmin data={overview} />
  if (overview.role === "venue_owner") return <OverviewVenue data={overview} />
  return <OverviewOrganizer data={overview} />
}
