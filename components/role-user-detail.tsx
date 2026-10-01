import { UserEventsTable } from "@/components/user-events-table"
import { SectionTitle } from "@/components/dashboard/primitives"

/**
 * One host account's events, for an admin.
 *
 * Shared by the organiser and venue-owner detail pages, which were the same
 * sixty lines twice. The account's name is each page's own `PageHeader`
 * (an owned header, `OWNED_HEADERS`), so this is the body only.
 */
export function RoleUserDetail({
  user,
}: {
  user: { organized_events: Parameters<typeof UserEventsTable>[0]["events"] }
}) {
  const n = user.organized_events.length

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <SectionTitle hint={`${n} created`}>Events</SectionTitle>
      <UserEventsTable events={user.organized_events} isAdmin />
    </section>
  )
}
