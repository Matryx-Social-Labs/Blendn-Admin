import Link from "next/link"
import { redirect } from "next/navigation"
import type { moderation_status_type } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { cn } from "@/lib/utils"

import { getModerationQueue } from "./actions"
import { ModerationTable } from "./moderation-table"
import { QueueSwitch } from "./queue-switch"

export const dynamic = "force-dynamic"

const TABS: Array<{ value: moderation_status_type; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
]

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const session = await getAuth()
  // Platform-wide queue: it spans every event, so unlike the per-event view it
  // cannot be scoped by ownership and is app_admin only.
  if (session?.user?.role !== "app_admin") redirect("/dashboard")

  const { status } = await searchParams
  const active = (TABS.find((tab) => tab.value === status)?.value ??
    "pending") as moderation_status_type

  const [{ rows, counts, highConfidence }, pendingReports] = await Promise.all([
    getModerationQueue(active),
    // Two cheap counts rather than the whole reports query: this page only
    // needs the number on the tab.
    Promise.all([
      db.user_reports.count({ where: { status: "pending" } }),
      db.message_reports.count({ where: { status: "pending" } }),
    ]).then(([u, m]) => u + m),
  ])

  return (
    <div className="flex flex-col gap-5">
      <QueueSwitch active="flags" reportCount={pendingReports} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1.5" aria-label="Moderation status">
          {TABS.map((tab) => (
            <Link
              key={tab.value}
              href={`/dashboard/moderation?status=${tab.value}`}
              aria-current={tab.value === active ? "page" : undefined}
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
        {active === "pending" && highConfidence > 0 ? (
          <span className="text-[0.75rem] text-destructive">
            {highConfidence} at or above 0.9 confidence
          </span>
        ) : null}
      </div>

      <ModerationTable rows={rows} status={active as "pending" | "approved" | "rejected"} />
    </div>
  )
}
