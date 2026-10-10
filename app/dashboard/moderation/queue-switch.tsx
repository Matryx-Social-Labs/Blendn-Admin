import { PillTabs } from "@/components/dashboard/kit"

/**
 * Flags and reports are two queues, and this is what says so.
 *
 * They are separate tables answering separate questions — a flag is the
 * moderation pipeline's opinion about one message, a report is a person asking
 * for help — but they are one job, done by one person, in one sitting. Without
 * a switch between them the reports queue is a URL nobody would find; the nav
 * has one "Moderation" entry and it has always pointed at flags.
 *
 * The kit's "Flags · N | Reports · N": both pending counts on both tabs, so the
 * queue you are not on still says how much is in it.
 */
export function QueueSwitch({
  active,
  flagCount,
  reportCount,
}: {
  active: "flags" | "reports"
  flagCount: number
  reportCount: number
}) {
  return (
    <PillTabs
      label="Moderation queue"
      active={active}
      tabs={[
        { key: "flags", href: "/dashboard/moderation", label: `Flags · ${flagCount}` },
        { key: "reports", href: "/dashboard/moderation/reports", label: `Reports · ${reportCount}` },
      ]}
    />
  )
}
