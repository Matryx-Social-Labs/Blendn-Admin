"use client"

import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react"

import type { Readiness } from "@/lib/event-readiness"

/**
 * What still blocks publishing, above the form rather than after Save.
 *
 * ## The panel this form did not have
 *
 * Deriving the screen from *what does this person need answered, in what order*
 * puts one question first: **can this be published at all?** The form answered
 * it last — you filled in 5,683px, pressed Create, and a toast refused you,
 * having already scrolled past the map that fixes it.
 *
 * ## Quiet when there is nothing to say
 *
 * It renders one line when the event is publishable, not a green success card.
 * A panel that congratulates you on every keystroke is a panel you stop reading,
 * and this one has to be believed on the day it says no.
 *
 * ## Two lists, because they are two different facts
 *
 * A blocker is the server refusing. A warning is something that will work and
 * probably should not. Collapsing them either cries wolf or hides a refusal
 * among advice.
 */
export function ReadinessStrip({ readiness }: { readiness: Readiness }) {
  const { blockers, warnings } = readiness

  if (blockers.length === 0 && warnings.length === 0) {
    return (
      <p className="flex items-center gap-2 text-[0.8125rem] text-success">
        <IconCircleCheck className="size-4 shrink-0" aria-hidden />
        Ready to publish.
      </p>
    )
  }

  return (
    <div
      className="flex flex-col gap-3"
      /*
        Polite, not assertive. It updates on every keystroke, and an assertive
        region would interrupt a screen-reader user mid-word while they type a
        title. `role="status"` is the polite default.
      */
      role="status"
      aria-live="polite"
    >
      {blockers.length > 0 ? (
        <div
          className="flex flex-col gap-1.5 rounded-lg border px-4 py-3"
          style={{
            borderColor: "color-mix(in oklab, var(--destructive) 40%, transparent)",
            background: "color-mix(in oklab, var(--destructive) 8%, transparent)",
          }}
        >
          <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-destructive">
            <IconAlertTriangle className="size-4 shrink-0" aria-hidden />
            {blockers.length === 1
              ? "One thing stops this publishing"
              : `${blockers.length} things stop this publishing`}
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-8 text-[0.8125rem]">
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[0.8125rem] text-muted-foreground">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2">
              <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
