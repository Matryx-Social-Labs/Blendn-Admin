import { notFound, redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { getRoleUserById } from "@/lib/admin-role-actions"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { UserEventsTable } from "@/components/user-events-table"
import { format } from "date-fns"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { IconArrowLeft } from "@tabler/icons-react"

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

  const initials = user.name
    ? user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : user.email[0].toUpperCase()

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
          <Link href="/dashboard/venue-owners">
            <IconArrowLeft className="mr-1 size-4" />
            Back to Venue Owners
          </Link>
        </Button>

        <div className="flex items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarImage src={user.image ?? ""} alt={user.name ?? user.email} />
            <AvatarFallback className="text-lg">{initials}</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-2xl font-semibold">{user.name ?? "Unnamed Venue Owner"}</h1>
            <p className="text-muted-foreground">{user.email}</p>
            <p className="text-muted-foreground text-sm">
              Joined {format(new Date(user.createdAt), "MMMM d, yyyy")} ·{" "}
              {user.organized_events.length} event
              {user.organized_events.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <h2 className="text-lg font-medium mb-3">Events</h2>
        <UserEventsTable events={user.organized_events} isAdmin={true} />
      </div>
    </div>
  )
}
