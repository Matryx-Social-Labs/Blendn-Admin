import { redirect } from "next/navigation"

import { MetricTile } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { getLeadAssignees, getLeadMetrics, getLeads } from "@/lib/lead-queries"
import type { lead_status } from "@prisma/client"

import { LeadsInbox } from "./leads-inbox"

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

  const [rows, metrics, assignees] = await Promise.all([
    getLeads({ status, q: sp.q, assignedTo: sp.assigned }),
    getLeadMetrics(),
    getLeadAssignees(),
  ])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        {/* h2, not h1: `components/site-header.tsx` owns the page's only h1. */}
        <h2 className="text-[length:var(--text-h1)] font-bold">Leads</h2>
        {/* The header says what these are. This says what they are not, which
            is the distinction that decides which queue a row belongs in. */}
        <p className="text-[0.8125rem] text-muted-foreground">
          Separate from applications — someone asking for a walkthrough has not asked
          for an account.
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        <MetricTile label="New this week" value={String(metrics.newThisWeek)} />
        <MetricTile
          label="Median time to contact"
          value={metrics.medianHoursToContact === null ? null : `${metrics.medianHoursToContact}h`}
          hint={metrics.medianHoursToContact === null ? "nothing contacted yet" : "last 30 days"}
        />
        <MetricTile
          label="Converted"
          value={metrics.conversionPct === null ? null : `${metrics.conversionPct}%`}
          hint="last 30 days, spam excluded"
        />
        {/* Deliberately prominent. If this number is ugly, the screen is doing
            its job by showing you. */}
        <MetricTile
          label="Oldest untouched"
          value={metrics.oldestUntouchedHours === null ? null : `${metrics.oldestUntouchedHours}h`}
          hint={metrics.oldestUntouchedHours === null ? "nothing waiting" : "nobody has replied"}
        />
      </div>

      <LeadsInbox rows={rows} assignees={assignees} />
    </div>
  )
}
