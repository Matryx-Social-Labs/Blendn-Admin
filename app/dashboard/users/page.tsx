import { IconUsers, IconUserCheck, IconMail, IconTrendingUp } from "@tabler/icons-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getUsers, getUserStats } from "./actions"
import { UsersTable } from "./users-table"

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const search = typeof params.search === "string" ? params.search : undefined
  const status = typeof params.status === "string" ? params.status : undefined

  const [{ users, total }, stats] = await Promise.all([
    getUsers(search, status, 50),
    getUserStats(),
  ])

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-muted-foreground">
          Manage user accounts, view profiles, and perform administrative actions.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <IconUsers className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalUsers.toLocaleString()}</div>
            <p className="text-muted-foreground text-xs">
              {stats.usersThisMonth} new this month
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Onboarded</CardTitle>
            <IconUserCheck className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.onboardedUsers.toLocaleString()}</div>
            <p className="text-muted-foreground text-xs">
              {stats.onboardingRate}% completion rate
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Verified</CardTitle>
            <IconMail className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.verifiedUsers.toLocaleString()}</div>
            <p className="text-muted-foreground text-xs">
              {stats.verificationRate}% of total users
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Growth</CardTitle>
            <IconTrendingUp className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.usersLastMonth > 0
                ? Math.round(
                    ((stats.usersThisMonth - stats.usersLastMonth) / stats.usersLastMonth) * 100
                  )
                : 0}
              %
            </div>
            <p className="text-muted-foreground text-xs">vs last month</p>
          </CardContent>
        </Card>
      </div>

      <div className="px-4 lg:px-6">
        <UsersTable data={users} total={total} />
      </div>
    </div>
  )
}
