"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { setOrganisationMaySponsor } from "@/lib/onboarding-actions"

/**
 * Grant or revoke an organisation's right to sell placement.
 *
 * The writer `organisations.may_sponsor` never had. It shipped with one reader
 * and no screen could set it, so the gate was correct in the deny direction and
 * the feature was unsellable.
 *
 * Shaped after `OrgStatusControl` deliberately — both are irreversible-feeling
 * admin acts that must record why, and an admin should not have to learn two
 * interaction patterns for the same kind of decision.
 */
export function OrgSponsorControl({
  orgId,
  maySponsor,
  status,
  name,
}: {
  orgId: string
  maySponsor: boolean
  status: string
  name: string
}) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()

  function apply(next: boolean) {
    start(async () => {
      try {
        await setOrganisationMaySponsor(orgId, next, reason)
        toast.success(
          next ? `${name} can now sell placement` : `${name} can no longer sell placement`
        )
        setConfirming(false)
        setReason("")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not change sponsorship access")
      }
    })
  }

  /*
   * A suspended org cannot be granted, and the control says so rather than
   * failing on click. The server enforces it too — this is the explanation, not
   * the guard.
   */
  if (!maySponsor && status !== "verified") {
    return (
      <p className="self-start text-[0.8125rem] text-muted-foreground">
        Verify {name} before granting sponsorship access.
      </p>
    )
  }

  if (maySponsor && !confirming) {
    return (
      <div className="flex items-center gap-2 self-start text-[0.8125rem] text-muted-foreground">
        <span>May sell placement</span>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Revoke
        </Button>
      </div>
    )
  }

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setConfirming(true)}>
        Grant sponsorship access
      </Button>
    )
  }

  const granting = !maySponsor

  return (
    <div className="flex max-w-prose flex-col gap-2 border-l-2 border-border-strong pl-3">
      <p className="text-[0.8125rem] leading-6">
        {granting ? (
          <>
            {name} will be able to mark broadcasts as <strong>sponsored</strong>. That
            label is a claim somebody paid, so record which agreement this is under.
          </>
        ) : (
          <>
            {name} will not be able to create new sponsored messages. Placements
            already running are <strong>not</strong> stopped — cancel those separately.
            Why?
          </>
        )}
      </p>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        className="rounded-lg"
        placeholder={
          granting
            ? "Signed placement agreement, Q3 2026, ref BL-1184"
            : "Agreement lapsed; no renewal"
        }
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={granting ? "default" : "destructive"}
          disabled={pending || reason.trim().length < 10}
          onClick={() => apply(granting)}
        >
          {granting ? "Grant" : "Revoke"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
