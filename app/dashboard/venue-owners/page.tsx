import Link from "next/link"
import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUsers } from "@/lib/admin-role-actions"
import { RoleUsersTable } from "@/components/role-users-table"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { IconCalendarEvent, IconUsers, IconBuildingStore } from "@tabler/icons-react"

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
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card px-6 py-6">
          <div>
            <h1 className="text-3xl font-semibold">Venue Owners</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Track venue-side operators, inventory depth, and the event portfolio each venue
              supports.
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard/venue-claims">Review claims</Link>
            </Button>
            <Button asChild>
              {/* Admin-created venues land unclaimed, which is how the directory
                  gets seeded before any owner is on the platform. */}
              <Link href="/dashboard/venues/new">Add a venue</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Venue Owners</CardTitle>
            <IconUsers className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Events</CardTitle>
            <IconCalendarEvent className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalEvents}</div>
          </CardContent>
        </Card>
      </div>

      {users.length === 0 && (
        <div className="px-4 lg:px-6">
          <div className="rounded-xl border border-dashed bg-card px-6 py-12 text-center">
            <div className="mx-auto flex max-w-md flex-col items-center gap-4">
              <div className="rounded-full border bg-muted p-4">
                <IconBuildingStore className="size-6 text-muted-foreground" />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">No venue owners found</h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  Once venue owner accounts are created, they will show up here with their
                  inventory and event portfolio.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="px-4 lg:px-6">
        <div className="rounded-xl border bg-card p-5">
          <RoleUsersTable
            users={users}
            role="venue_owner"
            roleLabel="Venue Owner"
            detailBasePath="/dashboard/venue-owners"
          />
        </div>
      </div>
    </div>
  )
}
