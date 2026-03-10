import { redirect } from "next/navigation"
import { EventEditor } from "@/components/event-editor"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"

export const dynamic = "force-dynamic"

export default async function NewEventPage() {
  const session = await getAuth()
  if (!session?.user || (session.user.role !== "app_admin" && session.user.role !== "organizer")) {
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
