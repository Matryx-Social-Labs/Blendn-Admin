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

  /*
   * Active only, in the vocabulary's own order. A retired amenity still
   * resolves on events that already reference it — the foreign key is
   * `Restrict` — but it is no longer offered for new ones.
   */
  const amenities = await db.amenities.findMany({
    where: { is_active: true },
    select: { id: true, name: true, subtitle: true },
    orderBy: { sort_order: "asc" },
  })

  return <EventEditor categories={categories} amenities={amenities} />
}
