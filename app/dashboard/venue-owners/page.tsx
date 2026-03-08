import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUsers } from "@/lib/admin-role-actions"
import { RoleUsersTable } from "@/components/role-users-table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { IconCalendarEvent, IconUsers } from "@tabler/icons-react"

export default async function VenueOwnersPage() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    redirect("/dashboard")
  }

  const users = await getRoleUsers("venue_owner")

  const totalEvents = users.reduce((sum, u) => sum + u._count.organized_events, 0)

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <h1 className="text-2xl font-semibold">Venue Owners</h1>
        <p className="text-muted-foreground">
          Manage venue owner accounts and generate onboarding credentials.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Venue Owners</CardTitle>
            <IconUsers className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Events</CardTitle>
            <IconCalendarEvent className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalEvents}</div>
          </CardContent>
        </Card>
      </div>

      <div className="px-4 lg:px-6">
        <RoleUsersTable
          users={users}
          role="venue_owner"
          roleLabel="Venue Owner"
          detailBasePath="/dashboard/venue-owners"
        />
      </div>
    </div>
  )
}
