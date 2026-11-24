import { Panel } from "@/components/dashboard/kit"
import { MetricTile } from "@/components/dashboard/primitives"
import { countLabel as count, formatNumber } from "@/lib/dashboard-format"
import { eventClock } from "@/lib/event-phase"
import type { LiveCrews } from "@/lib/live-metrics"

/**
 * "Crews tonight" (S8, crews board 07-hosts A): how many groups are here, how
 * much of the room they are, and whether they met. Read once a minute with
 * "Meeting tonight"; counts only, never a crew.
 */
export function CrewsTonightPanel({ crews, timezone }: { crews: LiveCrews | null; timezone: string }) {
  return (
    <Panel
      title="Crews tonight"
      action={<span className="shrink-0 text-[0.75rem] text-faint-foreground">updates every minute</span>}
      bodyClassName="pt-2"
    >
      {crews ? (
        <div className="grid grid-cols-3 gap-x-6">
          <MetricTile
            className="min-w-0 px-0 py-1.5"
            label="Crews here"
            value={count(crews.here)}
            hint={
              crews.peak
                ? `peak ${count(crews.peak.crews)}${crews.peak.at ? ` at ${eventClock(timezone).time(new Date(crews.peak.at))}` : ""}`
                : "none yet"
            }
          />
          <MetricTile
            className="min-w-0 px-0 py-1.5"
            label="People in crews"
            value={crews.people === "nearly_all" ? "nearly all" : count(crews.people)}
            hint={crews.pct !== null ? `${crews.pct}% of ${formatNumber(crews.guests)} here` : `of ${formatNumber(crews.guests)} here`}
          />
          <MetricTile className="min-w-0 px-0 py-1.5" label="Mixes made" value={count(crews.mixes)} hint="crew met crew, or one more" />
        </div>
      ) : (
        <p className="text-[0.78rem] text-muted-foreground">Counted while a day is on.</p>
      )}
    </Panel>
  )
}
