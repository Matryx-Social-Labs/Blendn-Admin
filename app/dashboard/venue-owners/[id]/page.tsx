import { format } from "date-fns"
import { notFound, redirect } from "next/navigation"

import { PageHeader } from "@/components/dashboard/page-header"
import { RoleUserDetail } from "@/components/role-user-detail"
import { getAuth } from "@/lib/auth"
import { getRoleUserById } from "@/lib/admin-role-actions"
import { accountTitleFor } from "@/lib/dashboard-record-titles"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: (await accountTitleFor((await params).id)) ?? "Venue owner" }
}

export default async function VenueOwnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    redirect("/dashboard")
  }

  const { id } = await params
  const user = await getRoleUserById(id)
  if (!user || user.role !== "venue_owner") notFound()

  // Owned header (`OWNED_HEADERS`): the account, by its name.
  return (
    <>
      <PageHeader
        title={user.name ?? "Unnamed venue owner"}
        description={`venue owner · joined ${format(user.createdAt, "d MMM yyyy")} · ${user.email}`}
        back={{ href: "/dashboard/venue-owners", label: "Venue owners" }}
      />
      <RoleUserDetail user={user} />
    </>
  )
}
