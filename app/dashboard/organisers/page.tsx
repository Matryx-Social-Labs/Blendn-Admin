import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUsers } from "@/lib/admin-role-actions"
import { RoleUsersTable } from "@/components/role-users-table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { IconCalendarEvent, IconUsers, IconUserPlus } from "@tabler/icons-react"

export default async function OrganisersPage() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    redirect("/dashboard")
  }

  const users = await getRoleUsers("organizer")

  const totalEvents = users.reduce((sum, u) => sum + u._count.organized_events, 0)

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <div className="rounded-xl border bg-card px-6 py-6">
          <h1 className="text-3xl font-semibold">Organisers</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Organisers</CardTitle>
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
                <IconUserPlus className="size-6 text-muted-foreground" />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">No organisers found</h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  Once organiser accounts are created, they will show up here with their event
                  activity and onboarding status.
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
            role="organizer"
            roleLabel="Organiser"
            detailBasePath="/dashboard/organisers"
          />
        </div>
      </div>
    </div>
  )
}
