import Link from "next/link"
import { redirect } from "next/navigation"
import type { moderation_status_type } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { unmoderatedPhotos } from "@/lib/photo-checks"
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

  const [
    { rows, counts, highConfidence, uncheckedLastHour, total },
    pendingReports,
    photoBacklog,
  ] = await Promise.all([
    getModerationQueue(active),
    // Two cheap counts rather than the whole reports query: this page only
    // needs the number on the tab.
    Promise.all([
      db.user_reports.count({ where: { status: "pending" } }),
      db.message_reports.count({ where: { status: "pending" } }),
    ]).then(([u, m]) => u + m),
    /*
     * A count, not the list. The decision this drives is "is photo moderation
     * running", which is a number; the images themselves are somebody's face
     * and do not belong on a queue screen that is about messages.
     */
    unmoderatedPhotos().then((rows) => rows.length),
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
        <div className="flex items-center gap-3">
          {active === "pending" && highConfidence > 0 ? (
            <span className="text-[0.75rem] text-destructive">
              {highConfidence} at or above 0.9 confidence
            </span>
          ) : null}
          {/*
            * The degraded-pipeline signal.
            *
            * An unchecked message was delivered without the model seeing it —
            * no API key, an API error, or a timeout. It used to be recorded as
            * `clean`, so a moderator watching a silent queue could not tell a
            * quiet night from a moderation pipeline that had been down for a
            * week. This is the number that makes the difference visible, which
            * is the whole reason `unchecked` is a state rather than a shrug.
            */}
          {uncheckedLastHour > 0 ? (
            <span
              className="rounded-full border border-destructive/40 px-2.5 py-1 text-[0.75rem] text-destructive"
              title="Delivered without reaching the moderation model — check OPENAI_API_KEY and the provider's status"
            >
              {uncheckedLastHour} unchecked in the last hour
            </span>
          ) : null}

          {/*
            The same argument, for photos.
            *
            * Photo moderation degrades OPEN by design — a vendor outage must
            * not stop somebody having a profile picture — and records
            * `checked: false` for a later sweep. There was no later sweep, and
            * no reader: `unmoderatedPhotos` was written, the index comment
            * called it "the sweeper's query", and the backlog was invisible.
            * An unchecked pile nobody can see is the same defect as an
            * unchecked message recorded as clean.
          */}
          {photoBacklog > 0 ? (
            <span
              className="text-[0.8125rem] font-bold text-warning"
              title="Uploaded while photo moderation could not run. They are live on profiles."
            >
              {photoBacklog} photo{photoBacklog === 1 ? "" : "s"} unchecked
            </span>
          ) : null}
        </div>
      </div>

      <ModerationTable rows={rows} status={active as "pending" | "approved" | "rejected"} />

      {total > rows.length ? (
        /* The queue is capped at a page. An admin who works through it and
           believes the queue is empty is the failure this line prevents. */
        <p className="text-[0.8125rem] text-muted-foreground">
          Showing the {rows.length} oldest of {total}.
        </p>
      ) : null}
    </div>
  )
}
