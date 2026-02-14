import { EventEditor } from "@/components/event-editor"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export default async function NewEventPage() {
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
