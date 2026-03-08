import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageEvent } from "@/lib/rbac"
import { EventMessaging } from "@/components/event-messaging"
import { Button } from "@/components/ui/button"

interface Props {
  params: Promise<{ id: string }>
}

export default async function EventMessagingPage({ params }: Props) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const { id: eventId } = await params

  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: { id: true, title: true, organizer_id: true },
  })

  if (!event) notFound()
  if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
    redirect("/dashboard/events")
  }

  return (
    <div className="container mx-auto max-w-3xl py-10 px-4">
      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-sm text-muted-foreground">{event.title}</p>
          <h1 className="text-2xl font-bold">Chatroom Messaging</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild size="sm">
            <Link href={`/dashboard/events/${eventId}`}>Edit Event</Link>
          </Button>
          <Button variant="outline" asChild size="sm">
            <Link href="/dashboard/events">All Events</Link>
          </Button>
        </div>
      </div>

      <EventMessaging eventId={event.id} eventTitle={event.title} />
    </div>
  )
}
