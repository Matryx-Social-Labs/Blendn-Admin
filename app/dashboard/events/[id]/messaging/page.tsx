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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { eventStateFor, STATE_LABEL } from "@/lib/event-phase"

interface Props {
  params: Promise<{ id: string }>
}

export default async function EventMessagingPage({ params }: Props) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const { id: eventId } = await params

  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      title: true,
      start_time: true,
      end_time: true,
      status: true,
      venue_name: true,
      organizer_org_id: true,
      venue: { select: { owner_org_id: true } },
    },
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

  const state = eventStateFor(event)
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  const when = `${fmt.format(event.start_time)} – ${new Intl.DateTimeFormat("en-GB", { timeStyle: "short" }).format(event.end_time)}`

  return (
    <div className="flex flex-col gap-5">
      {/*
        One title line, then the room. The site header owns the h1; the event
        page owns navigation back. What this page used to add — a second h1,
        two outline buttons and "Manage announcements and sponsored messages
        for X" — described the screen instead of being it.
      */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="text-[length:var(--text-h2)] font-bold">
          <Link href={`/dashboard/events/${eventId}`} className="hover:underline">
            {event.title}
          </Link>
        </h2>
        <span className="text-[0.8125rem] text-muted-foreground">
          {STATE_LABEL[state]} · {when}
          {event.venue_name ? ` · ${event.venue_name}` : ""}
        </span>
      </div>

      <div className="grid gap-8 @4xl/main:grid-cols-[minmax(0,1fr)_380px] @4xl/main:items-start">
        {/* The room, and what is waiting on a human. */}
        <Tabs defaultValue="chat" className="flex min-w-0 flex-col gap-3">
          <TabsList className="w-fit">
            <TabsTrigger value="chat">Messages</TabsTrigger>
            <TabsTrigger value="moderation">Moderation</TabsTrigger>
          </TabsList>
          <TabsContent value="chat">
            <ChatFeed eventId={event.id} />
          </TabsContent>
          <TabsContent value="moderation">
            <ModerationQueue eventId={event.id} />
          </TabsContent>
        </Tabs>

        {/*
          What `canEdit` buys: the composer and the sponsors. A venue owner
          gets the room and nothing to say into it — K3.12, R37.
        */}
        {permissions.canEdit ? (
          <div className="flex flex-col gap-6 @4xl/main:sticky @4xl/main:top-5">
            <EventMessaging eventId={event.id} />
            {/*
              Sponsors after the composer. A sponsored campaign is refused
              without a placement, and the fix for that refusal lives here.
            */}
            <div className="border-t border-border pt-5">
              <EventSponsors eventId={event.id} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
