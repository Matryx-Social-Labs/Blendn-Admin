"use client"

import { useState, type ReactNode } from "react"
import { IconLoader2 } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

/** The shortest reason that can say anything; every decide action refuses less. */
const MIN_REASON = 10

/**
 * Approve, or decline with a reason the other side is sent (the kit's
 * `DecideBox`). Venue claims, brand claims, creative review and applications
 * each had their own copy of this, down to the "N more characters needed".
 *
 * The reason is required because a decline with none produces an identical
 * re-file. The server enforces the same floor; this says it before the click.
 */
export function DecideBox({
  approveLabel,
  declineLabel = "Decline",
  sendLabel,
  reasonLabel,
  placeholder,
  pending,
  approveDisabled,
  approveTitle,
  outlineApprove,
  hint,
  onApprove,
  onDecline,
}: {
  approveLabel: string
  declineLabel?: string
  /** The button that sends the reason: "Send decline", "Send rejection". */
  sendLabel: string
  /** The textarea's accessible name, e.g. "Why the claim on Toit is declined". */
  reasonLabel: string
  placeholder: string
  pending: boolean
  /** Shown before the click rather than learned from a refusal. */
  approveDisabled?: boolean
  approveTitle?: string
  /** On a screen where neither action is the default (applications). */
  outlineApprove?: boolean
  /** One line beside the buttons on what they actually do. */
  hint?: ReactNode
  onApprove: () => void
  onDecline: (reason: string) => void
}) {
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState("")
  const short = MIN_REASON - reason.trim().length
  const spinner = pending ? <IconLoader2 className="size-4 animate-spin" /> : null

  if (declining) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={placeholder}
          aria-label={reasonLabel}
          rows={3}
          autoFocus
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-[0.75rem] text-faint-foreground" aria-live="polite">
            {short > 0 ? `${short} more character${short === 1 ? "" : "s"} needed.` : "Ready to send."}
          </p>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setDeclining(false)}>
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending || short > 0}
            onClick={() => onDecline(reason)}
          >
            {spinner}
            {sendLabel}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      {hint ? <p className="mr-auto text-[0.75rem] text-faint-foreground">{hint}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setDeclining(true)}>
          {declineLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={outlineApprove ? "outline" : "default"}
          disabled={pending || approveDisabled}
          title={approveTitle}
          onClick={onApprove}
        >
          {spinner}
          {approveLabel}
        </Button>
      </div>
    </div>
  )
}
