import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUsers } from "@/lib/admin-role-actions"
import { RoleUsersTable } from "@/components/role-users-table"

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
  const dormant = users.filter((u) => u.published === 0).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.8125rem] text-muted-foreground">
        <span>
          <b className="font-bold text-foreground tabular-nums">{users.length}</b> organiser
          {users.length === 1 ? "" : "s"}
        </span>
        <span>
          <span className="tabular-nums">{published}</span> published event
          {published === 1 ? "" : "s"}
        </span>
        {busiest && busiest.published > 0 ? (
          <span>
            busiest holds <span className="tabular-nums">{busiest.sharePct}%</span> ·{" "}
            {busiest.name ?? busiest.email}
          </span>
        ) : null}
        {/*
          Accounts that exist and have shipped nothing. On a two-sided product
          this is the acquisition number: supply that was recruited and never
          arrived, which no other screen counts.
        */}
        {dormant > 0 ? (
          <span className="font-medium text-warning">
            <span className="tabular-nums">{dormant}</span> never published
          </span>
        ) : null}
      </div>

      <RoleUsersTable
        users={users}
        role="organizer"
        roleLabel="Organiser"
        detailBasePath="/dashboard/organisers"
      />
    </div>
  )
}
