import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { EventMessaging } from "@/components/event-messaging"
import { ChatFeed } from "@/components/chat-feed"
import { ModerationQueue } from "@/components/moderation-queue"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface Props {
  params: Promise<{ id: string }>
}

export default async function EventMessagingPage({ params }: Props) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const { id: eventId } = await params

  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: { id: true, title: true, organizer_org_id: true, venue: { select: { owner_org_id: true } } },
  })

  if (!event) notFound()
  if (!eventPermissions(await actorFor(session.user), event).canEdit) {
    redirect("/dashboard/chatrooms")
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
        <div>
          <p className="text-sm text-muted-foreground">{event.title}</p>
          <h1 className="text-xl font-bold">Chatroom Messaging</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild size="sm">
            <Link href="/dashboard/chatrooms">Back to Chatrooms</Link>
          </Button>
          <Button variant="outline" asChild size="sm">
            <Link href={`/dashboard/events/${eventId}`}>Event overview</Link>
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
          <Tabs defaultValue="chat" className="flex flex-col h-full">
            <TabsList className="mx-4 mt-2 w-fit">
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="moderation">Moderation</TabsTrigger>
            </TabsList>
            <TabsContent value="chat" className="flex-1 min-h-0">
              <ChatFeed eventId={event.id} />
            </TabsContent>
            <TabsContent value="moderation" className="flex-1 min-h-0">
              <ModerationQueue eventId={event.id} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
