import { redirect } from "next/navigation"
import { EventEditor } from "@/components/event-editor"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"

export const dynamic = "force-dynamic"

export default async function NewEventPage() {
  const session = await getAuth()
  // venue_owner was redirected away from here, but `eventPermissions` grants
  // them both buckets on an event their own org runs — a venue owner hosting
  // their own night is a case the model explicitly supports and the UI
  // forbade. Attendees are the only role with no business on this screen.
  if (!session?.user || session.user.role === "attendee") {
    redirect("/dashboard/events")
  }

  const categories = await db.categories.findMany({
    select: {
      id: true,
      name: true,
    },
    orderBy: {
      name: "asc",
    },
  })

  return <EventEditor categories={categories} />
}
