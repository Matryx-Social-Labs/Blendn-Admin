"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { IconX } from "@tabler/icons-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SponsorPicker } from "@/components/sponsor-picker"
import { SPONSORSHIP } from "@/lib/constants"
import { getEventSponsors, removePlacement, type EventSponsorRow } from "@/lib/sponsor-actions"

const PHASE_LABEL: Record<string, string> = {
  draft: "Draft",
  proposed: "Invited",
  upcoming: "Ready",
  live: "Live",
  ended: "Ended",
  cancelled: "Cancelled",
}

/**
 * The sponsors on this event, and the picker to add one.
 *
 * Sits beside the campaign composer because the two are the same job: a
 * sponsored message cannot exist without a placement behind it, so an organiser
 * who has not attached a brand needs to see that here rather than discovering it
 * from a refused switch further down.
 */
export function EventSponsors({ eventId }: { eventId: string }) {
  const [rows, setRows] = useState<EventSponsorRow[] | null>(null)
  const [pending, start] = useTransition()

  const load = useCallback(() => {
    getEventSponsors(eventId)
      .then(setRows)
      .catch(() => setRows([]))
  }, [eventId])

  useEffect(load, [load])

  function remove(id: string, name: string) {
    start(async () => {
      try {
        await removePlacement(id)
        toast.success(`${name} removed from this event`)
        load()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not remove that")
      }
    })
  }

  // Only these occupy one of the three slots. A cancelled placement does not.
  const occupying = (rows ?? []).filter(
    (r) => r.status === "proposed" || r.status === "approved"
  ).length
  const full = occupying >= SPONSORSHIP.MAX_PLACEMENTS_PER_EVENT

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[0.9375rem] font-bold">Sponsors</h3>
        <span className="text-[0.8125rem] text-muted-foreground">
          {occupying} of {SPONSORSHIP.MAX_PLACEMENTS_PER_EVENT}
        </span>
      </div>

      {rows === null ? (
        <p className="text-[0.8125rem] text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          No sponsors on this event. A sponsored message needs a brand behind it,
          so add one here first.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border bg-card">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{r.name}</span>
                <span className="text-[0.8125rem] text-muted-foreground">
                  {r.ownerName ?? "Unclaimed"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={r.phase === "live" ? "secondary" : "outline"}>
                  {PHASE_LABEL[r.phase] ?? r.phase}
                </Badge>
                {r.status !== "cancelled" ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    disabled={pending}
                    title={`Remove ${r.name}`}
                    onClick={() => remove(r.id, r.name)}
                  >
                    <IconX className="size-4" />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {full ? (
        /*
         * Says why rather than rendering a dead input. The cap is a product
         * rule, not a bug, and an organiser who cannot see the reason will
         * assume the picker is broken.
         */
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          This event is carrying the maximum {SPONSORSHIP.MAX_PLACEMENTS_PER_EVENT}{" "}
          sponsors. Remove one to add another — a room people joined to talk to
          strangers is not an ad break.
        </p>
      ) : (
        <>
          <Separator />
          <SponsorPicker eventId={eventId} onAttached={load} />
        </>
      )}
    </section>
  )
}
