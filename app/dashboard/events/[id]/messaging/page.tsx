import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { EventMessaging } from "@/components/event-messaging"
import { EventSponsors } from "@/components/event-sponsors"
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

  /*
   * `canOperate`, not `canEdit` — and then the left column is what `canEdit`
   * buys.
   *
   * The event page gates on `canOperate` and `eventTabsFor` offers Chat and
   * Attendees on the same flag, under a comment reading "a tab list that offers
   * something the server will deny is its own bug". This route then denied on
   * `canEdit`, so a venue owner clicked a tab their own page had just offered
   * and was redirected to the **global chatrooms list, showing a different
   * event**. Not a refusal — a silent landing somewhere else.
   *
   * Driven on staging as the owner of QA Stadium, on an event another
   * organisation runs there. The overview card promises in as many words: "you
   * get the live view, the attendee count and the chatroom".
   *
   * The predicate could not simply be flipped, because this page is two things.
   * `canOperate` is defined as "chat, moderation, the attendee list — what
   * happens in your building", which is the right column exactly. The left is
   * a broadcast composer and sponsor placements: a venue owner announcing into
   * an event they do not run is K3.12, and R37 removes it deliberately.
   */
  const permissions = eventPermissions(await actorFor(session.user), event)
  if (!permissions.canOperate) redirect("/dashboard/chatrooms")

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
        <div>
          <p className="text-sm text-muted-foreground">{event.title}</p>
          {/*
            Named for what this actor gets. Without `canEdit` there is no
            composer and no sponsor panel, so "Messaging" would be a heading
            over the one thing the page no longer offers.
          */}
          <h1 className="text-xl font-bold">
            {permissions.canEdit ? "Chatroom Messaging" : "Chatroom"}
          </h1>
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
        {permissions.canEdit ? (
          <div className="w-[420px] shrink-0 overflow-y-auto p-6 flex flex-col gap-6 divide-y">
            {/*
              Sponsors first. A sponsored campaign below is refused without a
              placement, and the fix for that refusal lives here.
            */}
            <EventSponsors eventId={event.id} />
            <EventMessaging eventId={event.id} eventTitle={event.title} />
          </div>
        ) : null}

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
