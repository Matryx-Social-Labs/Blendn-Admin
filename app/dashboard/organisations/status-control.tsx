"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { setOrganisationStatus } from "@/lib/onboarding-actions"

/**
 * Suspend / reinstate one organisation.
 *
 * Suspending asks for a reason before it will go through — a suspension with no
 * recorded cause is impossible to review later, and the person who did it will
 * not remember either.
 */
export function OrgStatusControl({
  orgId,
  status,
  name,
}: {
  orgId: string
  status: string
  name: string
}) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()

  function apply(next: "verified" | "suspended") {
    start(async () => {
      try {
        await setOrganisationStatus(orgId, next, reason)
        toast.success(next === "suspended" ? `${name} suspended` : `${name} reinstated`)
        setConfirming(false)
        setReason("")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not change status")
      }
    })
  }

  if (status === "suspended") {
    return (
      <Button size="sm" variant="outline" className="self-start" disabled={pending} onClick={() => apply("verified")}>
        Reinstate
      </Button>
    )
  }

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setConfirming(true)}>
        Suspend
      </Button>
    )
  }

  return (
    <div className="flex max-w-prose flex-col gap-2 border-l-2 border-destructive pl-3">
      <p className="text-[0.8125rem] leading-6">
        Suspending {name} stops them operating. Nothing is deleted and it can be undone. Why?
      </p>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        className="rounded-lg"
        placeholder="Repeated no-shows; three unresolved attendee reports"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={pending || reason.trim().length < 10}
          onClick={() => apply("suspended")}
        >
          Suspend
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
