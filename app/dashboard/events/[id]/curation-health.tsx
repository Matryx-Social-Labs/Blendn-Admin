import { Badge } from "@/components/ui/badge"
import type { RefusalSummary } from "@/lib/check-in-refusals"
import type { CurationState } from "@/lib/curation"

/**
 * Why this curated event let nobody in.
 *
 * The queue screen finds the dead listings; this says which kind of dead. A
 * wrong pin, a wrong start time and a listing nobody wanted all produce zero
 * check-ins, and only the dominant refusal reason separates them.
 */
const REASON: Record<string, string> = {
  out_of_range: "Pin is probably wrong",
  no_geofence: "No fence to check against",
  too_early: "Start time is wrong",
  too_late: "End time is wrong",
  day_cancelled: "Day was cancelled",
  under_age: "Turned away on age",
}

export function CurationHealth({
  state,
  refusals,
}: {
  state: CurationState
  refusals: RefusalSummary
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3">
      <Badge variant="secondary" className="text-[0.6875rem]">
        {state === "curated_claimed" ? "Curated · claimed" : "Curated · unclaimed"}
      </Badge>
      <span className="text-sm font-medium text-destructive">
        {refusals.distinctPeopleRefused} turned away
      </span>
      {refusals.topReason ? (
        <span className="text-[0.8125rem] text-muted-foreground">
          {REASON[refusals.topReason] ?? refusals.topReason}
        </span>
      ) : null}
      {refusals.medianShortfallMetres !== null ? (
        <span className="text-[0.8125rem] tabular-nums text-muted-foreground">
          ~{refusals.medianShortfallMetres}m out
        </span>
      ) : null}
      {refusals.attempts > refusals.distinctPeopleRefused ? (
        <span className="text-[0.75rem] text-faint-foreground">
          {refusals.attempts} attempts
        </span>
      ) : null}
    </div>
  )
}
