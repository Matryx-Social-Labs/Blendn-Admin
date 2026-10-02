import { EventHeader } from "@/components/dashboard/event-header"
import { Panel } from "@/components/dashboard/kit"
import { eventTitleFor } from "@/lib/dashboard-record-titles"
import { loadEventPage } from "@/lib/event-page"
import { ChatFeed } from "@/components/chat-feed"
import { ModerationQueue } from "@/components/moderation-queue"

interface Props {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props) {
  const name = await eventTitleFor((await params).id)
  return { title: name ? `Room chat · ${name}` : "Room chat" }
}

/**
 * The event's Room chat tab: the feed, and beside it what is waiting on a
 * person.
 *
 * `canOperate`, not `canEdit` (`loadEventPage`). This route used to deny on
 * `canEdit` while the tab that led here was offered on `canOperate`, so a venue
 * owner clicked a tab their own page had just offered and was redirected to
 * the global chatrooms list, showing a different event. `canOperate` is defined
 * as "chat, moderation, the attendee list — what happens in your building",
 * which is this page exactly.
 *
 * The composer and the sponsor placements — what `canEdit` buys — are the
 * Announcements & sponsors tab now (step 15), not a column of this page. A
 * venue owner announcing into an event they do not run is K3.12, and R37
 * removes it deliberately.
 */
export default async function EventMessagingPage({ params }: Props) {
  const { id } = await params
  const data = await loadEventPage(id)
  const { event } = data

  return (
    <div className="flex flex-col gap-5">
      {/* Owned header (`OWNED_HEADERS`): the event's own, with its tabs. */}
      <EventHeader data={data} active="chat" />

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 @4xl/main:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title="Room chat" hint="attendees appear under generated names">
          <ChatFeed eventId={event.id} />
        </Panel>
        <div className="flex flex-col gap-5 @4xl/main:sticky @4xl/main:top-[84px]">
          <Panel title="Moderation">
            <ModerationQueue eventId={event.id} />
          </Panel>
          <Panel title="How it is checked">
            <p className="text-[0.8125rem] leading-5 text-muted-foreground">
              A keyword filter, a spam check and automated moderation read every message before anyone else sees
              it. Flags and reports wait here for a decision.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
