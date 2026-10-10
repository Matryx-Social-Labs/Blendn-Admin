import { UserEventsTable } from "@/components/user-events-table"
import { Panel } from "@/components/dashboard/kit"

/**
 * One host account's events, for an admin.
 *
 * Shared by the organiser and venue-owner detail pages, which were the same
 * sixty lines twice. The account's name is each page's own `PageHeader`
 * (an owned header, `OWNED_HEADERS`), so this is the body only: one Panel,
 * the table edge to edge inside it.
 */
export function RoleUserDetail({
  user,
}: {
  user: { organized_events: Parameters<typeof UserEventsTable>[0]["events"] }
}) {
  const n = user.organized_events.length

  return (
    <Panel title="Events" hint={`${n} created`} bodyClassName="px-0 pb-1 pt-3">
      <UserEventsTable events={user.organized_events} isAdmin />
    </Panel>
  )
}
