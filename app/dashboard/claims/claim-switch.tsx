import Link from "next/link"

import { cn } from "@/lib/utils"

/**
 * Claims on an event and claims on a venue are one job.
 *
 * Separate tables answering separate questions — "this event is mine" and "this
 * venue is mine" need different evidence and different scepticism — but they
 * are decided by one person, in one sitting, against the same instinct. The
 * plan's admin table is explicit that three claim queues answering one question
 * should be one screen.
 *
 * The same shape as `QueueSwitch` on the moderation screen, and for the reason
 * its docstring gives: without a switch, the second queue is a URL nobody would
 * find. `/dashboard/venue-claims` is where the venue queue used to live and
 * still redirects here, because a bookmark outliving a rename is cheaper than
 * an admin discovering the queue is gone.
 */
export function ClaimSwitch({
  active,
  eventCount,
  venueCount,
}: {
  active: "events" | "venues"
  eventCount: number
  venueCount: number
}) {
  const tabs = [
    { key: "events" as const, href: "/dashboard/claims", label: "Events", count: eventCount },
    { key: "venues" as const, href: "/dashboard/claims/venues", label: "Venues", count: venueCount },
  ]

  return (
    <nav className="flex gap-4 border-b border-border" aria-label="Claim queue">
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
          {tab.count > 0 ? (
            <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[0.6875rem] tabular-nums">
              {tab.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  )
}
