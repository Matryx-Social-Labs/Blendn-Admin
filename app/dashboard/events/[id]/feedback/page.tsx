import { redirect } from "next/navigation"
import { IconMessages } from "@tabler/icons-react"

import { EventHeader } from "@/components/dashboard/event-header"
import { Panel } from "@/components/dashboard/kit"
import { loadEventPage } from "@/lib/event-page"
import { buildFeedbackDigest } from "@/lib/feedback-digest"
import { liveCountLabel } from "@/lib/disclosure"

import { eventTabsFor } from "../event-tabs"

/** What a venue reads where a count of people is under the floor. */
const HELD_BACK = liveCountLabel("quiet")
import { eventTitleFor } from "@/lib/dashboard-record-titles"

import { CategoryBars } from "@/components/dashboard/charts"
import { EmptyState, RatingBars } from "@/components/dashboard/primitives"

import { FeedbackFeed } from "./feedback-feed"
import { eventClock } from "@/lib/event-phase"

export const dynamic = "force-dynamic"

function hoursUntil(iso: string) {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / (60 * 60 * 1000)))
}

/**
 * What a host reads the morning after.
 *
 * The premise: instead of emailing a survey nobody fills in, the chatroom stays
 * open after the event and catches people while they are still outside the
 * venue with an opinion. This is where that lands.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const name = await eventTitleFor((await params).id)
  return { title: name ? `Feedback · ${name}` : "Feedback" }
}

export default async function FeedbackPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  /*
   * The same door as every route under an event: a missing event is a 404, an
   * event this person may not operate sends them to the events list
   * (`loadEventPage`, tested in `event-feedback-page.test.tsx`).
   */
  const data = await loadEventPage(id)
  const { event, permissions } = data
  // A tab only once the event is over, and never on a venue day; the URL is
  // not a way round that.
  const offered = eventTabsFor(event.start_time.toISOString(), event.end_time.toISOString(), {
    canOperate: permissions.canOperate,
    canEdit: permissions.canEdit,
    canViewAttendees: permissions.canViewAttendees,
    kind: event.kind,
    status: event.status,
  }).some((t) => t.key === "feedback")
  if (!offered) redirect(`/dashboard/events/${event.id}`)
  // Built from the event the loader read: one read, not two. A venue sees
  // every count of people held back under the floor.
  const digest = await buildFeedbackDigest(event, permissions.canEdit ? "host" : "venue")

  const total = digest.total
  const share = (n: number | null) => (!total || n === null ? 0 : (n / total) * 100)
  const figure = (n: number | null) => (n === null ? HELD_BACK : n)
  const topIssue = digest.categories[0]

  const ended = eventClock(digest.timezone).format(new Date(digest.endedAt), {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
  const window = digest.windowOpen
    ? `feedback window closes in ${hoursUntil(digest.windowClosesAt)}h`
    : "feedback window closed"
  const { ratingCount } = digest

  return (
    <div className="flex flex-col gap-5">
      {/* Owned header (`OWNED_HEADERS`): the event's own, with its tabs. */}
      <EventHeader data={data} active="feedback" />
      <p className="text-[0.8125rem] text-muted-foreground">
        {`${digest.ended ? "Ended" : "Ends"} ${ended} · ${window}${
          total === null ? " · fewer than five messages" : total > 0 ? ` · ${total} message${total === 1 ? "" : "s"}` : ""
        }`}
      </p>

      {total === 0 ? (
        <EmptyState
          icon={<IconMessages />}
          title={digest.windowOpen ? "Nothing yet — the window is open" : "No feedback was captured"}
          description={
            digest.windowOpen
              ? "What people say while still outside the venue lands here, labelled positive, negative or neutral and by what it was about."
              : "The chat window closed without anything being classified."
          }
        />
      ) : (
        <>
          {/*
            The split is the hero, and it is the only colour on the screen —
            a full-width bar above everything, because "was it good" is the
            question, and this answers it before a single word is read.
          */}
          <Panel bodyClassName="gap-2.5">
            {total === null ? null : (
            <div className="flex h-3 overflow-hidden rounded-full bg-surface-raised">
              <div className="bg-success" style={{ width: `${share(digest.counts.positive)}%` }} />
              <div className="bg-border-strong" style={{ width: `${share(digest.counts.neutral)}%` }} />
              <div className="bg-destructive" style={{ width: `${share(digest.counts.negative)}%` }} />
            </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
              <span>
                <b className="font-bold tabular-nums text-success">{figure(digest.counts.positive)}</b> positive
              </span>
              <span>
                <b className="font-bold tabular-nums text-foreground">{figure(digest.counts.neutral)}</b> neutral
              </span>
              <span>
                <b className="font-bold tabular-nums text-destructive">{figure(digest.counts.negative)}</b>{" "}
                negative
              </span>
            </div>
            {/* The takeaway, stated rather than left to be inferred from a
                chart — the point of classifying by category at all. */}
            <p className="max-w-[60ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
              {digest.counts.negative === null ? (
                "Fewer than five said anything negative, or nothing was said at all — held back, so it cannot point at anybody."
              ) : digest.counts.negative === 0 ? (
                "Nothing negative was classified. Read the messages anyway — the classifier is cautious, not omniscient."
              ) : topIssue?.suppressed ? (
                /* Below the disclosure floor the count is null and the quotes
                   are held back too, so "<5 of 1 … read them" would promise a
                   read the page cannot give. Name the category; that is what
                   is disclosed. */
                <>
                  The negatives are the takeaway. Fewer than five people raised them, so the
                  category is listed —{" "}
                  <b className="font-medium text-foreground">{topIssue.category.replace(/_/g, " ")}</b>
                  {" "}— and the messages are held back until more people say the same thing.
                </>
              ) : topIssue ? (
                <>
                  The negatives are the takeaway, and{" "}
                  <b className="font-medium text-foreground">
                    {topIssue.count} of {digest.counts.negative}
                  </b>{" "}
                  are about{" "}
                  <b className="font-medium text-foreground">{topIssue.category.replace(/_/g, " ")}</b>.
                  With this few, read them — they are short.
                </>
              ) : (
                "Negatives were recorded without a clear category. Read them directly."
              )}
            </p>
          </Panel>

          <div className="grid gap-5 @4xl/main:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @4xl/main:items-start">
            <Panel title="What people said" hint="tap a label to correct it — the classifier misses sarcasm">
              <FeedbackFeed messages={digest.messages} timezone={digest.timezone} />
            </Panel>

            <div className="flex flex-col gap-5">
              {digest.categories.length > 0 ? (
                <Panel>
                  <CategoryBars
                    title="What went wrong"
                    hint="negative + safety messages"
                    data={digest.categories}
                  />
                </Panel>
              ) : null}

              {/* Stars only when somebody gave one. Five empty bars under
                  "No ratings" is a chart of nothing. */}
              {ratingCount === null || ratingCount > 0 ? (
                <Panel
                  title="Stars"
                  hint={
                    ratingCount === null
                      ? "fewer than five ratings"
                      : `${digest.averageRating === null ? "" : `${digest.averageRating} · `}${ratingCount} rating${ratingCount === 1 ? "" : "s"}`
                  }
                >
                  {/* Withheld under five raters: each score is somebody's (SCRUM-437). */}
                  {digest.averageRating === null ? (
                    <p className="text-[0.8125rem] text-muted-foreground">
                      Not enough ratings yet.
                    </p>
                  ) : (
                    <>
                      <RatingBars counts={digest.ratings} />
                      <p className="text-[0.75rem] text-faint-foreground">
                        Stars say how much; the messages say what.
                      </p>
                    </>
                  )}
                </Panel>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
