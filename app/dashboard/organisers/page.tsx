import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUsers } from "@/lib/admin-role-actions"
import { neverPublished } from "@/lib/dashboard-format"
import { StatLine } from "@/components/dashboard/kit"
import { RoleUsersTable } from "@/components/role-users-table"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/organisers")

export default async function OrganisersPage() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    redirect("/dashboard")
  }

  const users = await getRoleUsers("organizer")

  /*
   * The page's own description promises "who publishes, and how concentrated it
   * is", and the screen carried neither: two bordered cards reading `Total
   * Organisers` and `Total Events`, the second of which counted drafts as
   * supply.
   *
   * Concentration is the number this screen exists for. One host holding half
   * the platform's published events is the host-liquidity risk in a single
   * figure, and it is the only thing here that changes a decision.
   */
  const published = users.reduce((sum, u) => sum + u.published, 0)
  const busiest = users.reduce<(typeof users)[number] | null>(
    (top, u) => (top === null || u.published > top.published ? u : top),
    null
  )
  const dormant = neverPublished(users)

  return (
    <div className="flex flex-col gap-4">
      <RoleUsersTable
        users={users}
        role="organizer"
        roleLabel="Organiser"
        detailBasePath="/dashboard/organisers"
        summary={
          /*
            Accounts that exist and have shipped nothing ("never published")
            are, on a two-sided product, the acquisition number: supply that was
            recruited and never arrived, which no other screen counts.
          */
          <StatLine
            items={[
              { value: users.length, label: users.length === 1 ? "organiser" : "organisers" },
              { value: published, label: published === 1 ? "published event" : "published events" },
              busiest !== null &&
                busiest.published > 0 && {
                  value: `${busiest.sharePct}%`,
                  label: `held by the busiest · ${busiest.name ?? busiest.email}`,
                },
              dormant > 0 && { value: dormant, label: "never published", tone: "warning" },
            ]}
          />
        }
      />
    </div>
  )
}
