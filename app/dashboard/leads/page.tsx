import { redirect } from "next/navigation"

import { KpiStrip } from "@/components/dashboard/kit"
import { getAuth } from "@/lib/auth"
import { getLeadAssignees, getLeadMetrics, getLeads, getLeadStatusCounts } from "@/lib/lead-queries"
import type { lead_status } from "@prisma/client"

import { LeadsInbox } from "./leads-inbox"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/leads")

export const dynamic = "force-dynamic"

/**
 * Demo requests from organizers.blendn.app.
 *
 * Admin-only. A lead carries a stranger's name, email, IP and user agent —
 * marketing PII, and organisers have no business in it.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const sp = await searchParams
  // Defaults to `new`, not everything. An unfiltered list of every lead ever
  // received is history; the inbox should show work.
  const status = (sp.status ?? "new") as lead_status | "open" | "all"

  const [rows, metrics, assignees, counts] = await Promise.all([
    getLeads({ status, q: sp.q, assignedTo: sp.assigned }),
    getLeadMetrics(),
    getLeadAssignees(),
    getLeadStatusCounts(),
  ])

  return (
    <div className="flex flex-col gap-5">
      {/* The header says what these are. This says what they are not, which
          is the distinction that decides which queue a row belongs in. */}
      <p className="text-[0.8125rem] text-muted-foreground">
        Separate from applications — someone asking for a walkthrough has not asked
        for an account.
      </p>

      {/* One strip, the kit's way. "Oldest untouched" is deliberately in it: if
          this number is ugly, the screen is doing its job by showing you. */}
      <KpiStrip
        items={[
          { label: "New this week", value: String(metrics.newThisWeek) },
          {
            label: "Median time to contact",
            value: metrics.medianHoursToContact === null ? null : `${metrics.medianHoursToContact}h`,
            hint: metrics.medianHoursToContact === null ? "nothing contacted yet" : "last 30 days",
          },
          {
            label: "Converted",
            value: metrics.conversionPct === null ? null : `${metrics.conversionPct}%`,
            hint: "last 30 days, spam excluded",
          },
          {
            label: "Oldest untouched",
            value: metrics.oldestUntouchedHours === null ? null : `${metrics.oldestUntouchedHours}h`,
            hint: metrics.oldestUntouchedHours === null ? "nothing waiting" : "nobody has replied",
          },
        ]}
      />

      <LeadsInbox rows={rows} assignees={assignees} counts={counts} />
    </div>
  )
}
