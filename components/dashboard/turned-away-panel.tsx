import Link from "next/link"

import { GOOD_FIX_METRES, type EventRefusals } from "@/lib/check-in-refusals"
import { cn } from "@/lib/utils"

/**
 * Who could not get in, and whose fault it was (SCRUM-196).
 *
 * Sits under Attendance and reads like it: one figure, muted qualifiers, and a
 * sentence where Attendance has its turn-up chip. The sentence is the point.
 * Two people refused at good fixes means the fence did not contain people who
 * knew exactly where they were, and the organiser should move the pin or widen
 * the radius; two people at poor fixes means the phones were wrong and moving
 * the pin would be a mistake. Nothing else on the dashboard can make that call,
 * and `check_in_refusals.accuracy_metres` exists so this one can.
 *
 * Only `out_of_range` earns a verdict. Someone turned away before doors or on
 * age is listed in the chips and says nothing about the pin. Hidden at zero by
 * the caller: "0 turned away" asserts the absence of a problem nobody asked
 * about.
 */

/** "~845 km out" / "~40 m out" — the organiser's units, not a seven-digit metre count. */
export function shortfall(metres: number): string {
  return metres >= 1000 ? `~${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km out` : `~${metres} m out`
}

function accuracyRange(a: { min: number; max: number }): string {
  return a.min === a.max ? `${a.min} m` : `${a.min}–${a.max} m`
}

export function TurnedAwayPanel({
  refusals,
  eventId,
  canEdit,
}: {
  refusals: EventRefusals
  eventId: string
  /** The link to the editor is only offered to somebody who can use it. */
  canEdit: boolean
}) {
  const { people, byReason, medianShortfallMetres, accuracy, verdict } = refusals
  const fence = verdict === "fence" || verdict === "mixed"

  return (
    <section className="flex flex-col gap-2.5" aria-labelledby="turned-away-heading">
      <h3 id="turned-away-heading" className="text-sm font-bold">
        Turned away
      </h3>
      <div className="flex flex-wrap items-baseline gap-3.5">
        <span
          className={cn(
            "text-[1.625rem] font-bold leading-[1.1] tabular-nums",
            verdict === "fence" && "text-destructive"
          )}
        >
          {people}
          <span className="text-sm font-normal text-muted-foreground"> couldn&rsquo;t get in</span>
        </span>
        {medianShortfallMetres !== null ? (
          <span className="text-[0.8125rem] tabular-nums text-muted-foreground">
            {shortfall(medianShortfallMetres)}
          </span>
        ) : null}
      </div>

      {verdict && accuracy ? (
        <p className="max-w-[60ch] text-[0.8125rem] text-muted-foreground">
          {verdict === "fence" ? (
            <>
              At <b className="font-semibold text-foreground">good fixes ({accuracyRange(accuracy)})</b>, so
              it&rsquo;s the fence, not the phones.
            </>
          ) : verdict === "phones" ? (
            <>
              At <b className="font-semibold text-foreground">poor fixes ({accuracyRange(accuracy)})</b> —
              the phones, not the fence. Nothing to move.
            </>
          ) : (
            <>
              Fixes ranged <b className="font-semibold text-foreground">{accuracyRange(accuracy)}</b> — some
              phones knew where they were and the fence still didn&rsquo;t hold them.
            </>
          )}
          {fence && canEdit ? (
            <>
              {" "}
              <Link
                href={`/dashboard/events/${eventId}/edit#step-where`}
                className="font-medium text-primary hover:underline"
              >
                Move the pin or widen the radius&nbsp;&rarr;
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {byReason.map((r, i) => (
          <span
            key={r.reason}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[0.75rem] tabular-nums",
              i === 0 ? "border-border-strong font-medium" : "border-border"
            )}
          >
            {r.label} · {r.people}
          </span>
        ))}
      </div>

      <p className="text-[0.7188rem] text-faint-foreground">
        Distinct people.
        {accuracy
          ? ` A fix of ${GOOD_FIX_METRES} m or better counts as good; the app refuses worse ones before they reach the door.`
          : ""}
      </p>
    </section>
  )
}
