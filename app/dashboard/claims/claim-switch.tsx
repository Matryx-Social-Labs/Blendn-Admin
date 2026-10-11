import { PillTabs } from "@/components/dashboard/kit"

/**
 * Claims on an event and claims on a venue are one job.
 *
 * Separate tables answering separate questions — "this event is mine" and "this
 * venue is mine" need different evidence and different scepticism — but they
 * are decided by one person, in one sitting, against the same instinct. The
 * plan's admin table is explicit that three claim queues answering one question
 * should be one screen.
 *
 * The same control as `QueueSwitch` on the moderation screen — the kit's
 * "Events · N | Venues · N | Brands · N" pills, each a URL — and for the reason
 * its docstring gives: without a switch, the second queue is a URL nobody would
 * find. `/dashboard/venue-claims` is where the venue queue used to live and
 * still redirects here, because a bookmark outliving a rename is cheaper than
 * an admin discovering the queue is gone.
 */
export function ClaimSwitch({
  active,
  eventCount,
  venueCount,
  brandCount,
}: {
  active: "events" | "venues" | "brands"
  eventCount: number
  venueCount: number
  brandCount: number
}) {
  return (
    <PillTabs
      label="Claim queue"
      active={active}
      tabs={[
        { key: "events", href: "/dashboard/claims", label: `Events · ${eventCount}` },
        { key: "venues", href: "/dashboard/claims/venues", label: `Venues · ${venueCount}` },
        /*
         * The third queue, folded in. It asks the same question the other two do —
         * somebody wants ownership of something, and approving hands it over — and
         * it lived on its own URL with its own nav entry purely because it was
         * built last.
         */
        { key: "brands", href: "/dashboard/claims/brands", label: `Brands · ${brandCount}` },
      ]}
    />
  )
}
