import { notFound } from "next/navigation"
import { IconMessages } from "@tabler/icons-react"

import { PageHeader } from "@/components/dashboard/page-header"
import { eventTitleFor } from "@/lib/dashboard-record-titles"

import { CategoryBars } from "@/components/dashboard/charts"
import { EmptyState, RatingBars, SectionTitle } from "@/components/dashboard/primitives"

import { getFeedbackDigest } from "./actions"
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
  const digest = await getFeedbackDigest(id)
  if (!digest) notFound()

  const total = digest.counts.positive + digest.counts.neutral + digest.counts.negative
  const share = (n: number) => (total === 0 ? 0 : (n / total) * 100)
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
      {/* Owned header (`OWNED_HEADERS`). The event page owns the tabs; this goes back. */}
      <PageHeader
        title={digest.eventTitle}
        description={`${digest.ended ? "ended" : "ends"} ${ended} · ${window}${total > 0 ? ` · ${total} message${total === 1 ? "" : "s"}` : ""}`}
        back={{ href: `/dashboard/events/${id}`, label: "Back to event" }}
      />

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
          <section className="flex flex-col gap-2.5">
            <div className="flex h-3 overflow-hidden rounded-full bg-surface-raised">
              <div className="bg-success" style={{ width: `${share(digest.counts.positive)}%` }} />
              <div className="bg-border-strong" style={{ width: `${share(digest.counts.neutral)}%` }} />
              <div className="bg-destructive" style={{ width: `${share(digest.counts.negative)}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
              <span>
                <b className="font-bold tabular-nums text-success">{digest.counts.positive}</b> positive
              </span>
              <span>
                <b className="font-bold tabular-nums text-foreground">{digest.counts.neutral}</b> neutral
              </span>
              <span>
                <b className="font-bold tabular-nums text-destructive">{digest.counts.negative}</b>{" "}
                negative
              </span>
            </div>
            {/* The takeaway, stated rather than left to be inferred from a
                chart — the point of classifying by category at all. */}
            <p className="max-w-[60ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
              {digest.counts.negative === 0 ? (
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
          </section>

          <div className="grid gap-8 @4xl/main:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @4xl/main:items-start">
            <section className="flex flex-col gap-3 border-t border-border pt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <SectionTitle>What people said</SectionTitle>
                <span className="text-[0.75rem] text-faint-foreground">
                  tap a label to correct it — the classifier misses sarcasm
                </span>
              </div>
              <FeedbackFeed messages={digest.messages} timezone={digest.timezone} />
            </section>

            <div className="flex flex-col gap-5">
              {digest.categories.length > 0 ? (
                <section className="border-t border-border pt-5">
                  <CategoryBars
                    title="What went wrong"
                    hint="negative + safety messages"
                    data={digest.categories}
                  />
                </section>
              ) : null}

              {/* Stars only when somebody gave one. Five empty bars under
                  "No ratings" is a chart of nothing. */}
              {ratingCount > 0 ? (
                <section className="flex flex-col gap-2.5 border-t border-border pt-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <SectionTitle>Stars</SectionTitle>
                    <span className="text-[0.75rem] text-faint-foreground">
                      {digest.averageRating === null ? "" : `${digest.averageRating} · `}
                      {ratingCount} rating{ratingCount === 1 ? "" : "s"}
                    </span>
                  </div>
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
                </section>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
