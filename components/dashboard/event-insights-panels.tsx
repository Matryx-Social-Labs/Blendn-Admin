import Link from "next/link"
import { IconLock } from "@tabler/icons-react"

import { Panel } from "@/components/dashboard/kit"
import { formatNumber } from "@/lib/dashboard-format"
import type { FewCount, HeldTotal } from "@/lib/disclosure"
import { eventClock } from "@/lib/event-phase"
import type { EventInsights, Stage } from "@/lib/event-insights"
import type { FeedbackDigest } from "@/lib/feedback-digest"
import { cn } from "@/lib/utils"

/*
 * Post A (SCRUM-1051, mockup post-A-did-people-meet.png): the Overview's "Did
 * people meet" funnel, then the night's mood, the Lobby and Tonight's question
 * side by side. Every figure arrives disclosed (lib/event-insights.ts); this
 * file only prints it, and never a number the server did not send.
 */

/** A count as printed: a few is words, a held total its floor (`discloseGroup`). */
const count = (c: FewCount | HeldTotal) => (c === "few" ? "a few" : typeof c === "number" ? formatNumber(c) : `${formatNumber(c.atLeast)}+`)

const WAYS = [
  { key: "waves", one: "mutual wave", many: "mutual waves" },
  { key: "lobby", one: "Lobby ask accepted", many: "Lobby asks accepted" },
  { key: "requests", one: "request", many: "requests" },
] as const

export function DidPeopleMeetPanel({ insights }: { insights: EventInsights }) {
  const { attendees, funnel } = insights
  return (
    <Panel title="Did people meet" action={<span className="shrink-0 text-[0.75rem] text-faint-foreground">counted once per pair</span>} bodyClassName="gap-2.5 pt-3">
      {funnel.held ? (
        <p className="max-w-[60ch] text-[0.8125rem] text-muted-foreground">
          {attendees === 0
            ? "Nobody checked in, so there was nobody to meet."
            : `Held back until ${funnel.floor} people have attended. With ${formatNumber(attendees)}, who met whom is plain to anyone who was there.`}
        </p>
      ) : (
        <>
          <dl className="flex flex-col gap-2">
            <FunnelRow label="Came" stage={{ count: attendees, pct: 100 }} whole />
            <FunnelRow label="Reached out" stage={funnel.reachedOut} />
            <FunnelRow label="Met someone" stage={funnel.met} />
            <FunnelRow label="Kept talking" stage={funnel.keptTalking} />
          </dl>
          <p className="text-[0.78rem] leading-relaxed text-muted-foreground">
            {funnel.connections === 0 ? (
              "No connections: a pair counts once both say yes."
            ) : (
              <>
                {count(funnel.connections)} connection{funnel.connections === 1 ? "" : "s"}
                {funnel.byWay
                  ? ` — ${WAYS.filter((w) => funnel.byWay![w.key] !== 0)
                      .map((w) => `${count(funnel.byWay![w.key])} ${funnel.byWay![w.key] === 1 ? w.one : w.many}`)
                      .join(" · ")}`
                  : " (how they met was not recorded for this night)"}
                .{funnel.perAttendee !== null ? ` ${funnel.perAttendee} per person.` : null}{" "}
                {/* The published benchmark, stated rather than implied. */}
                {funnel.met.pct >= 50
                  ? "Above the 50% point where a networking format is considered to be working."
                  : "Formats are generally considered to be working once met someone passes 50%."}
              </>
            )}
          </p>
        </>
      )}
    </Panel>
  )
}

function FunnelRow({ label, stage, whole }: { label: string; stage: Stage | null | "not_recorded"; whole?: boolean }) {
  const shown = stage !== null && stage !== "not_recorded"
  const text =
    stage === "not_recorded"
      ? "not recorded for this night"
      : stage === null
        ? "held back"
        : whole
          ? formatNumber(stage.count)
          : `${formatNumber(stage.count)} · ${stage.pct}%`
  const labelClass = "absolute inset-y-0 left-2.5 flex items-center whitespace-nowrap text-[0.8125rem] tabular-nums"
  return (
    <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-3 @xl/main:grid-cols-[8.5rem_minmax(0,1fr)]">
      <dt className="text-right text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="relative h-7 overflow-hidden rounded bg-surface-raised">
        {/* Light on the track; the fill draws over it with the same words in dark, clipped to its width, so the figure reads at any width. */}
        <span className={cn(labelClass, shown ? "font-bold text-foreground" : "text-faint-foreground")}>{text}</span>
        {shown ? (
          <div className="absolute inset-y-0 left-0 overflow-hidden rounded bg-primary" style={{ width: `${stage.pct}%` }} aria-hidden>
            <span className={cn(labelClass, "font-bold text-primary-foreground")}>{text}</span>
          </div>
        ) : null}
      </dd>
    </div>
  )
}

/** The night's mood, from the Feedback digest; the quotes stay on Feedback. */
export function NightMoodPanel({ mood, live, eventId }: { mood: Pick<FeedbackDigest, "counts" | "total" | "categories">; live: boolean; eventId: string }) {
  const { positive, neutral, negative } = mood.counts
  const total = mood.total ?? 0
  const top = mood.categories[0]
  const width = (n: number | null) => `${total === 0 ? 0 : ((n ?? 0) / total) * 100}%`
  return (
    <Panel
      title={live ? "Mood — so far" : "Mood — whole night"}
      action={<span className="shrink-0 text-[0.75rem] tabular-nums text-faint-foreground">{formatNumber(total)} classified msg{total === 1 ? "" : "s"}</span>}
      bodyClassName="gap-2.5 pt-3"
    >
      {total === 0 ? (
        <p className="text-[0.78rem] text-muted-foreground">Nothing in the room chat was classified.</p>
      ) : (
        <>
          <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised" aria-hidden>
            <div className="bg-success" style={{ width: width(positive) }} />
            <div className="bg-border-strong" style={{ width: width(neutral) }} />
            <div className="bg-destructive" style={{ width: width(negative) }} />
          </div>
          <p className="text-[0.78rem] tabular-nums text-muted-foreground">
            {formatNumber(positive)} positive · {formatNumber(neutral)} neutral · {formatNumber(negative)} negative
          </p>
        </>
      )}
      <p className="text-[0.78rem] text-muted-foreground">
        {top ? `Top complaint: ${top.category.replaceAll("_", " ")}${top.count !== null ? ` (${formatNumber(top.count)})` : ""}. ` : "No complaints classified. "}
        {live ? (
          "Quotes come to Feedback after the end."
        ) : (
          <Link href={`/dashboard/events/${eventId}/feedback`} className="underline underline-offset-[3px]">
            Quotes in Feedback
          </Link>
        )}
      </p>
    </Panel>
  )
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
      <span className="text-[1.625rem] font-bold leading-[1.1] tabular-nums">{value}</span>
      <span className="text-[0.75rem] text-faint-foreground">{hint}</span>
    </div>
  )
}

export function LobbyCountsPanel({ lobby, pinnedSince, timezone }: { lobby: EventInsights["lobby"]; pinnedSince: string | null; timezone: string }) {
  const kinds = (
    [
      [lobby.offer, "offering"],
      [lobby.seeking, "looking for"],
      [lobby.chat, "just saying"],
    ] as const
  ).filter(([c]) => c !== 0)
  return (
    <Panel title="Lobby" action={<span className="shrink-0 text-[0.75rem] text-faint-foreground">counts only</span>} bodyClassName="gap-3 pt-3">
      <div className="grid grid-cols-2 gap-x-6">
        <Figure label="Posts" value={count(lobby.posts)} hint={kinds.length ? kinds.map(([c, l]) => `${count(c)} ${l}`).join(" · ") : "nobody posted"} />
        <Figure
          label="Asks"
          value={count(lobby.asks)}
          hint={lobby.asks === 0 ? "nobody asked" : lobby.accepted === null ? "accepted held back" : `${formatNumber(lobby.accepted)} accepted`}
        />
      </div>
      {pinnedSince ? (
        <p className="text-[0.75rem] text-muted-foreground">Your pinned note was up from {eventClock(timezone).time(new Date(pinnedSince))}.</p>
      ) : null}
    </Panel>
  )
}

const INTENTS = [
  ["hire", "hire"],
  ["find_work", "find work"],
  ["build", "build"],
  ["learn", "learn"],
] as const

export function TonightCountsPanel({ tonight, crews, attendees }: Pick<EventInsights, "tonight" | "crews" | "attendees">) {
  const answered = tonight?.answered
  return (
    <Panel title="Tonight’s question" action={<span className="shrink-0 text-[0.75rem] text-faint-foreground">never the answers</span>} bodyClassName="gap-3 pt-3">
      <div className="grid grid-cols-2 gap-x-6">
        <Figure
          label="Answered"
          value={answered === undefined ? "—" : answered === "nearly_all" ? "nearly all" : count(answered)}
          hint={
            answered === undefined
              ? "no question asked"
              : tonight?.pct !== null && tonight?.pct !== undefined
                ? `of ${formatNumber(attendees)} · ${tonight.pct}%`
                : `of ${formatNumber(attendees)}`
          }
        />
        <Figure
          label="Crews"
          value={crews === "not_recorded" ? "—" : count(crews.came)}
          hint={crews === "not_recorded" ? "not recorded for this night" : crews.came === 0 ? "no crew came" : `${count(crews.people)} people`}
        />
      </div>
      <p className="text-[0.75rem] text-muted-foreground">
        {tonight?.workIntent
          ? `Here to: ${INTENTS.map(([k, l]) => `${l} ${count(tonight.workIntent!.parts[k])}`).join(" · ")}`
          : "“Here to” mix shows on work-lens events."}
      </p>
    </Panel>
  )
}

export function AggregatesNote() {
  return (
    <p className="flex items-center gap-1.5 text-[0.75rem] text-faint-foreground">
      <IconLock aria-hidden className="size-3.5 shrink-0" />
      Aggregates only. Counts under 5 people are held back; connections wait for 8 people. No names, no ids, no answers.
    </p>
  )
}
