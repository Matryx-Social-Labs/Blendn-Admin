import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUsers } from "@/lib/admin-role-actions"
import { RoleUsersTable } from "@/components/role-users-table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { IconCalendarEvent, IconUsers } from "@tabler/icons-react"

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
        <div className="rounded-[1.8rem] border border-white/10 brand-surface px-6 py-6">
          <h1 className="text-3xl font-semibold text-white">Organisers</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/62">
            Manage organiser accounts, review event supply, and support host onboarding.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 sm:grid-cols-2">
        <Card className="rounded-[1.6rem] border-white/10 bg-white/[0.04] text-white shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Organisers</CardTitle>
            <IconUsers className="size-4 text-white/46" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.length}</div>
          </CardContent>
        </Card>
        <Card className="rounded-[1.6rem] border-white/10 bg-white/[0.04] text-white shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Events</CardTitle>
            <IconCalendarEvent className="size-4 text-white/46" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalEvents}</div>
          </CardContent>
        </Card>
      </div>

      <div className="px-4 lg:px-6">
        <div className="rounded-[1.8rem] border border-white/10 bg-white/[0.04] p-5">
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
