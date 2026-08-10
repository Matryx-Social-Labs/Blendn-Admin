import Link from "next/link"

import { cn } from "@/lib/utils"

/**
 * Flags and reports are two queues, and this is what says so.
 *
 * They are separate tables answering separate questions — a flag is the
 * moderation pipeline's opinion about one message, a report is a person asking
 * for help — but they are one job, done by one person, in one sitting. Without
 * a switch between them the reports queue is a URL nobody would find; the nav
 * has one "Moderation" entry and it has always pointed at flags.
 */
export function QueueSwitch({
  active,
  reportCount,
}: {
  active: "flags" | "reports"
  reportCount: number
}) {
  const tabs = [
    { key: "flags" as const, href: "/dashboard/moderation", label: "Flags" },
    { key: "reports" as const, href: "/dashboard/moderation/reports", label: "Reports" },
  ]

  return (
    <nav className="flex gap-4 border-b border-border" aria-label="Moderation queue">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-0.5 pb-2 text-sm transition-colors",
            tab.key === active
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
          {tab.key === "reports" && reportCount > 0 ? (
            <span className="ml-1.5 rounded-full bg-destructive/15 px-1.5 py-0.5 text-[0.6875rem] text-destructive tabular-nums">
              {reportCount}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  )
}
