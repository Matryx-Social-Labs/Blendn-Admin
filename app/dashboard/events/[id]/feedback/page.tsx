import Link from "next/link"
import { notFound } from "next/navigation"
import { IconArrowLeft, IconMessages } from "@tabler/icons-react"

import { CategoryBars } from "@/components/dashboard/charts"
import { EmptyState, RatingBars, SectionTitle } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"

import { getFeedbackDigest } from "./actions"
import { FeedbackFeed } from "./feedback-feed"

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

  return (
    <div className="flex flex-col gap-5">
      <Link
        href={`/dashboard/events/${id}`}
        className="inline-flex w-fit items-center gap-1.5 text-[0.8125rem] text-muted-foreground hover:text-foreground"
      >
        <IconArrowLeft className="size-4" />
        {digest.eventTitle}
      </Link>

      <div className="flex flex-wrap items-baseline gap-2.5">
        <h2 className="text-[length:var(--text-h2)] font-bold">{digest.eventTitle}</h2>
        <span className="text-[0.8125rem] text-muted-foreground">
          ended{" "}
          {new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(
            new Date(digest.endedAt)
          )}
        </span>
        <Badge variant={digest.windowOpen ? "default" : "secondary"}>
          {digest.windowOpen
            ? `window closes in ${hoursUntil(digest.windowClosesAt)}h`
            : "window closed"}
        </Badge>
      </div>

      {total === 0 ? (
        <EmptyState
          icon={<IconMessages />}
          title={digest.windowOpen ? "Nothing yet — the window is open" : "No feedback was captured"}
          description={
            digest.windowOpen
              ? "What people say while still outside the venue lands here, labelled positive, negative or neutral and by what it was about — the honest review no emailed survey gets."
              : "The chat window closed without anything being classified. Nothing to read for this one."
          }
        />
      ) : (
        <div className="grid gap-5 @4xl/main:grid-cols-[2fr_3fr] @4xl/main:items-start">
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-bold">The morning after</h3>
                <span className="text-[0.75rem] text-faint-foreground">{total} messages</span>
              </div>

              <div className="flex h-3.5 overflow-hidden rounded-full bg-surface-raised">
                <div className="bg-success" style={{ width: `${share(digest.counts.positive)}%` }} />
                <div className="bg-border-strong" style={{ width: `${share(digest.counts.neutral)}%` }} />
                <div className="bg-destructive" style={{ width: `${share(digest.counts.negative)}%` }} />
              </div>

              <div className="flex flex-wrap gap-3.5 text-[0.78rem] text-muted-foreground">
                <span>
                  <b className="font-bold tabular-nums text-success">{digest.counts.positive}</b>{" "}
                  positive
                </span>
                <span>
                  <b className="font-bold tabular-nums">{digest.counts.neutral}</b> neutral
                </span>
                <span>
                  <b className="font-bold tabular-nums text-destructive">
                    {digest.counts.negative}
                  </b>{" "}
                  negative
                </span>
              </div>

              {/* The takeaway, stated rather than left to be inferred from a
                  chart — the point of classifying by category at all. */}
              <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
                {digest.counts.negative === 0 ? (
                  "Nothing negative was classified. Read the messages anyway — the classifier is cautious, not omniscient."
                ) : topIssue ? (
                  <>
                    The negatives are the takeaway, and{" "}
                    <b className="font-medium text-foreground">
                      {topIssue.count ?? "<5"} of {digest.counts.negative}
                    </b>{" "}
                    are about{" "}
                    <b className="font-medium text-foreground">
                      {topIssue.category.replace(/_/g, " ")}
                    </b>
                    . With this few, read them — they are short.
                  </>
                ) : (
                  "Negatives were recorded without a clear category. Read them directly."
                )}
              </p>
            </section>

            {digest.categories.length > 0 ? (
              <CategoryBars
                title="What went wrong"
                hint="negative + safety messages"
                data={digest.categories}
              />
            ) : null}

            <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-bold">Star ratings</h3>
                <span className="text-[0.75rem] text-faint-foreground">
                  separate, thinner signal
                </span>
              </div>
              <RatingBars counts={digest.ratings} />
              <p className="text-[0.75rem] text-faint-foreground">
                {digest.averageRating === null
                  ? "No ratings submitted."
                  : `${digest.averageRating} average. Stars tell you how much; the messages tell you what.`}
              </p>
            </section>
          </div>

          <div className="flex flex-col gap-3">
            <SectionTitle>What people said</SectionTitle>
            <FeedbackFeed messages={digest.messages} />
          </div>
        </div>
      )}
    </div>
  )
}
