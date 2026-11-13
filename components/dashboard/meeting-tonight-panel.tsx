import { Panel } from "@/components/dashboard/kit"
import { MetricTile } from "@/components/dashboard/primitives"
import { formatNumber } from "@/lib/dashboard-format"
import type { FewCount, HeldTotal, LiveSocial } from "@/lib/live-metrics"

/** A count as the panel prints it: a few is words, a held total its floor (`discloseGroup`), never the number. */
const count = (c: FewCount | HeldTotal) => (c === "few" ? "a few" : typeof c === "number" ? formatNumber(c) : `${formatNumber(c.atLeast)}+`)

/** The three ways two people meet here, in the bar's order and colours (approval 1). */
const WAYS = [
  { key: "waves", label: "mutual waves", color: "var(--chart-1)" },
  { key: "lobby", label: "Lobby asks accepted", color: "var(--chart-2)" },
  { key: "requests", label: "requests accepted", color: "var(--chart-3)" },
] as const

/**
 * "Meeting tonight" (Live A, SCRUM-1051, mockup `live-A-meeting-panel.png`):
 * whether the room is working while there is still time to act. The share who
 * met someone carries its own split, so the host sees how people meet, not
 * just how many. Read once a minute; counts only, a few under five.
 */
export function MeetingTonightPanel({ social }: { social: LiveSocial }) {
  const { attendees, met, conversations, lobby, tonight, crews } = social

  return (
    <Panel
      title="Meeting tonight"
      // Right-aligned, as the mockup has it: the cadence, not a subtitle.
      action={<span className="shrink-0 text-[0.75rem] text-faint-foreground">updates every minute</span>}
      bodyClassName="gap-3 pt-3"
    >
      {met.held ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          Held back until {met.floor} guests have checked in. With {formatNumber(attendees)}, who met whom is
          plain to anyone in the room.
        </p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-[1.625rem] font-bold leading-[1.1] tabular-nums">{met.pct}%</span>
            <span className="text-[0.8125rem] text-muted-foreground">
              have met someone · {formatNumber(met.connected)} of {formatNumber(attendees)} guests
            </span>
          </p>
          <WaysBar byWay={met.byWay} />
          <p className="text-[0.78rem] leading-relaxed text-muted-foreground">
            {met.connections === 0 ? (
              "No connections yet: a pair counts once both say yes."
            ) : (
              <>
                {count(met.connections)} connection{met.connections === 1 ? "" : "s"}:{" "}
                {WAYS.filter((w) => met.byWay[w.key] !== 0).map((w, i) => (
                  <span key={w.key}>
                    {i > 0 ? " · " : null}
                    <b className="font-bold" style={{ color: w.color }}>
                      {count(met.byWay[w.key])} {w.label}
                    </b>
                  </span>
                ))}
              </>
            )}
          </p>
        </>
      )}

      <div className="grid grid-cols-2 gap-x-8 gap-y-1">
        <MetricTile className="min-w-0 px-0 py-1.5" label="Conversations" value={count(conversations)} hint="opened tonight" />
        <MetricTile className="min-w-0 px-0 py-1.5" label="Lobby" value={count(lobby.posts)} hint={lobbyHint(lobby)} />
        {tonight ? (
          <MetricTile
            className="min-w-0 px-0 py-1.5"
            label="Tonight’s question"
            value={
              tonight.answered === "nearly_all"
                ? "nearly all"
                : tonight.answered === "few"
                  ? "a few"
                  : `${formatNumber(tonight.answered)}/${formatNumber(attendees)}`
            }
            hint="answered"
          />
        ) : null}
        <MetricTile
          className="min-w-0 px-0 py-1.5"
          label="Crews here"
          value={crews ? count(crews.here) : null}
          hint={crews ? (crews.here === 0 ? "none here yet" : `${count(crews.people)} people`) : "between days"}
        />
      </div>
    </Panel>
  )
}

/**
 * The connections split by way, drawn from what was disclosed only: a way under
 * five has no number on the wire, so it is one grey "a few" step, never its width.
 */
function WaysBar({ byWay }: { byWay: Record<(typeof WAYS)[number]["key"], FewCount> }) {
  const parts = WAYS.flatMap((w) =>
    byWay[w.key] === 0 ? [] : [{ key: w.key, n: byWay[w.key] === "few" ? FEW_WIDTH : (byWay[w.key] as number), color: byWay[w.key] === "few" ? undefined : w.color }]
  )
  const total = parts.reduce((sum, p) => sum + p.n, 0)
  if (total === 0) return <div className="h-2 rounded-full bg-surface-raised" aria-hidden />
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised" aria-hidden>
      {parts.map((p) => (
        <div key={p.key} className={p.color ? undefined : "bg-border-strong"} style={{ width: `${(p.n / total) * 100}%`, background: p.color }} />
      ))}
    </div>
  )
}

/** The width a "few" way is drawn at: a nominal step, not its count (the count is not sent). */
const FEW_WIDTH = 2

/** The Lobby's posts in the app's words: Offering, Looking for, Just saying. */
function lobbyHint(lobby: LiveSocial["lobby"]): string {
  if (lobby.posts === 0) return "no posts yet"
  const parts = [
    [lobby.offer, "offering"],
    [lobby.seeking, "looking for"],
    [lobby.chat, "just saying"],
  ] as const
  return parts
    .filter(([c]) => c !== 0)
    .map(([c, label]) => `${count(c)} ${label}`)
    .join(" · ")
}
