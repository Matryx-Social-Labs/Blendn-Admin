import { redirect } from "next/navigation"
import type { report_status } from "@prisma/client"

import { PillTabs } from "@/components/dashboard/kit"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"

import { QueueSwitch } from "../queue-switch"
import { getReportQueue } from "./actions"
import { ReportsTable } from "./reports-table"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/moderation/reports")

export const dynamic = "force-dynamic"

/** Reviewed: looked at, no action taken. Resolved: acted on. The empty state says so. */
const TABS: Array<{ value: report_status; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "reviewed", label: "Reviewed" },
  { value: "resolved", label: "Resolved" },
]

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const session = await getAuth()
  // Platform-wide and it names people: app_admin only, like the flag queue.
  if (session?.user?.role !== "app_admin") redirect("/dashboard")

  const { status } = await searchParams
  const active = (TABS.find((tab) => tab.value === status)?.value ?? "pending") as report_status

  const [{ rows, counts, truncated }, pendingFlags] = await Promise.all([
    getReportQueue(active),
    // The other queue's number, for its tab.
    db.moderation_flags.count({ where: { status: "pending" } }),
  ])

  return (
    <div className="flex flex-col gap-5">
      <QueueSwitch active="reports" flagCount={pendingFlags} reportCount={counts.pending ?? 0} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PillTabs
          label="Report status"
          active={active}
          tabs={TABS.map((tab) => ({
            key: tab.value,
            href: `/dashboard/moderation/reports?status=${tab.value}`,
            label: counts[tab.value] ? `${tab.label} · ${counts[tab.value]}` : tab.label,
          }))}
        />
        {truncated ? (
          // Said out loud rather than silently truncated: a capped queue that
          // looks complete is how a backlog gets missed.
          <span className="text-[0.8125rem] text-muted-foreground">
            Showing the oldest 100 of each kind
          </span>
        ) : null}
      </div>

      <ReportsTable rows={rows} status={active as "pending" | "reviewed" | "resolved"} />
    </div>
  )
}
