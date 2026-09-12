import { notFound, redirect } from "next/navigation"

import { RoleUserDetail } from "@/components/role-user-detail"
import { getAuth } from "@/lib/auth"
import { getRoleUserById } from "@/lib/admin-role-actions"

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

  return <RoleUserDetail user={user} kind="Venue owner" />
}
