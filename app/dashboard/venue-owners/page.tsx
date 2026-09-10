import Link from "next/link"
import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUsers } from "@/lib/admin-role-actions"
import { RoleUsersTable } from "@/components/role-users-table"
import { Button } from "@/components/ui/button"

export default async function VenueOwnersPage() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    redirect("/dashboard")
  }

  const users = await getRoleUsers("venue_owner")

  const published = users.reduce((sum, u) => sum + u.published, 0)
  const dormant = users.filter((u) => u.published === 0).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.8125rem] text-muted-foreground">
          <span>
            <b className="font-bold text-foreground tabular-nums">{users.length}</b> venue owner
            {users.length === 1 ? "" : "s"}
          </span>
          {/*
            Events they CREATED, which is not the same as events at their
            venues — `eventScope` is `organizer_id` here and H2 records that a
            venue owner operates every event in their building whoever made it.
            Labelled precisely rather than counted wrongly; the building-level
            figure needs a join through `venues.owner_org_id` and belongs on the
            venue index, not on a list of people.
          */}
          <span>
            <span className="tabular-nums">{published}</span> event
            {published === 1 ? "" : "s"} of their own
          </span>
          {dormant > 0 ? (
            <span className="font-medium text-warning">
              <span className="tabular-nums">{dormant}</span> never published
            </span>
          ) : null}
        </div>
        {/*
          Two buttons, out of the bordered card that held nothing else. A card
          exists to group things; one containing a single row of controls is
          100px of chrome around a toolbar.
        */}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" className="rounded-full">
            <Link href="/dashboard/claims/venues">Review claims</Link>
          </Button>
          <Button asChild variant="outline" className="rounded-full">
            {/* Admin-created venues land unclaimed, which is how the directory
                gets seeded before any owner is on the platform. */}
            <Link href="/dashboard/venues/new">Add a venue</Link>
          </Button>
        </div>
      </div>

      <RoleUsersTable
        users={users}
        role="venue_owner"
        roleLabel="Venue Owner"
        detailBasePath="/dashboard/venue-owners"
      />
    </div>
  )
}
