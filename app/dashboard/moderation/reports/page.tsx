import Link from "next/link"
import { redirect } from "next/navigation"
import type { report_status } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"

import { QueueSwitch } from "../queue-switch"
import { getReportQueue } from "./actions"
import { ReportsTable } from "./reports-table"

export const dynamic = "force-dynamic"

const TABS: Array<{ value: report_status; label: string; hint: string }> = [
  { value: "pending", label: "Pending", hint: "Waiting for a human" },
  { value: "reviewed", label: "Reviewed", hint: "Looked at, no action taken" },
  { value: "resolved", label: "Resolved", hint: "Acted on" },
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

  const { rows, counts, truncated } = await getReportQueue(active)

  return (
    <div className="flex flex-col gap-5">
      <QueueSwitch active="reports" reportCount={counts.pending ?? 0} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1.5" aria-label="Report status">
          {TABS.map((tab) => (
            <Link
              key={tab.value}
              href={`/dashboard/moderation/reports?status=${tab.value}`}
              aria-current={tab.value === active ? "page" : undefined}
              title={tab.hint}
              className={cn(
                "rounded-full border border-border px-3 py-1.5 text-[0.8125rem] transition-colors",
                tab.value === active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {tab.label}
              {counts[tab.value] ? ` ${counts[tab.value]}` : ""}
            </Link>
          ))}
        </nav>
        {truncated ? (
          // Said out loud rather than silently truncated: a capped queue that
          // looks complete is how a backlog gets missed.
          <span className="text-[0.75rem] text-muted-foreground">
            Showing the oldest 100 of each kind
          </span>
        ) : null}
      </div>

      <ReportsTable rows={rows} status={active as "pending" | "reviewed" | "resolved"} />
    </div>
  )
}
