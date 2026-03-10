import { redirect } from "next/navigation"
import { IconUsers, IconUserCheck, IconMail, IconTrendingUp } from "@tabler/icons-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getUsers, getUserStats } from "./actions"
import { UsersTable } from "./users-table"
import { getAuth } from "@/lib/auth"

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const search = typeof params.search === "string" ? params.search : undefined
  const status = typeof params.status === "string" ? params.status : undefined

  const [{ users, total }, stats, session] = await Promise.all([
    getUsers(search, status, 50),
    getUserStats(),
    getAuth(),
  ])

  if (!session?.user || session.user.role !== "app_admin") {
    redirect("/dashboard")
  }

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <div className="rounded-[1.8rem] border border-white/10 brand-surface px-6 py-6">
          <h1 className="text-3xl font-semibold text-white">Users</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/62">
            Manage user accounts, review onboarding quality, and shape the audience story behind the product.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        <Card className="rounded-[1.6rem] border-white/10 bg-white/[0.04] text-white shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <IconUsers className="size-4 text-white/46" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalUsers.toLocaleString()}</div>
            <p className="text-xs text-white/54">
              {stats.usersThisMonth} new this month
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-[1.6rem] border-white/10 bg-white/[0.04] text-white shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Onboarded</CardTitle>
            <IconUserCheck className="size-4 text-white/46" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.onboardedUsers.toLocaleString()}</div>
            <p className="text-xs text-white/54">
              {stats.onboardingRate}% completion rate
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-[1.6rem] border-white/10 bg-white/[0.04] text-white shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Verified</CardTitle>
            <IconMail className="size-4 text-white/46" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.verifiedUsers.toLocaleString()}</div>
            <p className="text-xs text-white/54">
              {stats.verificationRate}% of total users
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-[1.6rem] border-white/10 bg-white/[0.04] text-white shadow-none">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Growth</CardTitle>
            <IconTrendingUp className="size-4 text-white/46" />
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
            <p className="text-xs text-white/54">vs last month</p>
          </CardContent>
        </Card>
      </div>

      <div className="px-4 lg:px-6">
        <div className="rounded-[1.8rem] border border-white/10 bg-white/[0.04] p-5">
          <UsersTable data={users} total={total} currentUserRole={session?.user?.role ?? "attendee"} />
        </div>
      </div>
    </div>
  )
}
