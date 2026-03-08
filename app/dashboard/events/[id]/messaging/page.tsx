import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageEvent } from "@/lib/rbac"
import { EventMessaging } from "@/components/event-messaging"
import { ChatFeed } from "@/components/chat-feed"
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
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
        <div>
          <p className="text-sm text-muted-foreground">{event.title}</p>
          <h1 className="text-xl font-bold">Chatroom Management</h1>
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

      {/* Two-column layout */}
      <div className="flex flex-1 min-h-0 divide-x">
        {/* Left: Messaging controls */}
        <div className="w-[420px] shrink-0 overflow-y-auto p-6">
          <EventMessaging eventId={event.id} eventTitle={event.title} />
        </div>

        {/* Right: Live chat feed + moderation */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <ChatFeed eventId={event.id} />
        </div>
      </div>
    </div>
  )
}
