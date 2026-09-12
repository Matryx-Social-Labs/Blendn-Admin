import { cn } from "@/lib/utils"
import { STATE_LABEL, type EventState } from "@/lib/event-phase"

const PHASES = (Object.keys(STATE_LABEL) as EventState[]).map((key) => ({ key, label: STATE_LABEL[key] }))

/**
 * Where the event is in its life, before the page says anything else.
 *
 * Four phases on a line; the current one lit, the ones behind it filled, the
 * ones ahead outlined, a date under each. The tabs hang off it (Live appears
 * while it is live, Feedback once it is over), and the one question the
 * overview asks is the question of the lit phase. A cancelled event says so
 * in the same slot rather than pretending to be upcoming.
 */
export function EventLifecycle({
  state,
  cancelled,
  dates,
}: {
  state: EventState
  cancelled: boolean
  dates: Record<EventState, string>
}) {
  const current = PHASES.findIndex((p) => p.key === state)
  return (
    <ol
      className="relative mt-3 grid grid-cols-4 gap-2 before:absolute before:left-2 before:right-2 before:top-[7px] before:h-px before:bg-border-strong"
      aria-label={cancelled ? "This event is cancelled" : `This event is ${state}`}
    >
      {PHASES.map((phase, i) => {
        const past = i < current
        const now = i === current && !cancelled
        return (
          <li
            key={phase.key}
            aria-current={now ? "step" : undefined}
            className={cn(
              "relative pt-[18px] text-[0.75rem] before:absolute before:left-0 before:top-0 before:size-[15px] before:rounded-full before:border-[1.5px] before:border-border-strong before:bg-background",
              past && "text-muted-foreground before:border-muted-foreground before:bg-muted-foreground",
              now &&
                "font-bold text-foreground before:border-transparent before:bg-[image:var(--gradient-brand)] before:shadow-[0_0_0_4px_color-mix(in_oklab,var(--primary)_25%,transparent)]",
              !past && !now && "text-faint-foreground",
              cancelled && i === current && "line-through decoration-destructive"
            )}
          >
            {cancelled && i === current ? "Cancelled" : phase.label}
            <span className={cn("block font-normal", now ? "text-muted-foreground" : "text-faint-foreground")}>
              {dates[phase.key]}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
