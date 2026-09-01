"use client"

import { useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { decidePlacement } from "@/lib/sponsor-actions"

/**
 * Accept or decline a placement an organiser offered.
 *
 * Two buttons rather than a confirm dialog. Both are reversible in practice —
 * an organiser can offer again — and a modal on a list row means closing one to
 * look at the next, which is the same reason `OnboardingQueue` expands inline.
 *
 * Declining is `variant="ghost"` deliberately: it is not destructive, and
 * dressing it in red would make a routine "not this one" feel like a decision
 * somebody has to steel themselves for.
 */
export function PlacementDecision({ placementId }: { placementId: string }) {
  const [pending, start] = useTransition()

  function decide(accept: boolean) {
    start(async () => {
      try {
        await decidePlacement(placementId, accept)
        toast.success(accept ? "Placement accepted" : "Placement declined")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save that")
      }
    })
  }

  return (
    <div className="flex gap-2">
      <Button size="sm" disabled={pending} onClick={() => decide(true)}>
        Accept
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide(false)}>
        Decline
      </Button>
    </div>
  )
}
