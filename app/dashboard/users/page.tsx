import { redirect } from "next/navigation"
import { getUsers, getUserStats } from "./actions"
import { UsersTable } from "./users-table"
import { StatLine } from "@/components/dashboard/kit"
import { getAuth } from "@/lib/auth"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/users")

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const search = typeof params.search === "string" ? params.search : undefined
  const status = typeof params.status === "string" ? params.status : undefined

  /*
   * The gate runs before the fetch, not beside it.
   *
   * These three were in one `Promise.all` with the role check after it — so
   * `getUsers` refused first and the refusal arrived as **"Something went
   * wrong. The page failed to load."** An organiser opening this URL got an
   * error boundary rather than a redirect, which reads as a broken product
   * rather than as a closed door.
   *
   * Nothing leaked: `getUsers` throws Forbidden on its own, which is the
   * defence-in-depth working. What was wrong is that a correct refusal was
   * rendered as a crash. `/dashboard/organisers` had it in the right order
   * already, which is what made the difference visible.
   */
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    redirect("/dashboard")
  }

  const [{ users, total }, stats] = await Promise.all([
    getUsers(search, status, 50),
    getUserStats(),
  ])

  return (
    <div className="flex flex-col gap-4">
      {/*
        One line of numbers, where four bordered cards used to be.

        This screen is a finding tool, not a metrics screen: an admin opens it
        to locate one person and see whether anything is wrong with them. Four
        cards at identical weight answered none of that and pushed the search
        box — the actual control — below the fold on a laptop.

        `suspended` is the only one that means somebody should look, so it is
        the only one that gets a warning colour, and only when it is not zero.
        `deleted` is the opposite — the system having worked — so it sits last,
        fainter than the rest, and also only when it is not zero.
      */}
      <StatLine
        items={[
          { value: stats.total.toLocaleString(), label: stats.total === 1 ? "account" : "accounts" },
          { value: stats.onboarded.toLocaleString(), label: "onboarded" },
          { value: stats.verified.toLocaleString(), label: "verified" },
          stats.suspended > 0 && { value: stats.suspended.toLocaleString(), label: "suspended", tone: "destructive" },
          stats.deleted > 0 && { value: stats.deleted.toLocaleString(), label: "deleted", tone: "faint" },
        ]}
      />

      <UsersTable
        data={users}
        total={total}
        currentUserRole={session?.user?.role ?? "attendee"}
      />
    </div>
  )
}
