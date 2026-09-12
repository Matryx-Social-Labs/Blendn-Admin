"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { IconLoader2 } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { unlinkEventVenue } from "@/lib/venue-link-actions"

/**
 * Taking an event off a venue it was linked to in error.
 *
 * ## Why this is not cosmetic
 *
 * `lib/venue-claim-actions.ts` justifies its review bar in prose:
 *
 * > The reason this does not have to be bulletproof: **auto-link is
 * > reversible.** An organiser can unlink any event from a venue, with a
 * > reason, audited. A wrong approval is recoverable, so the queue can be
 * > careful without being paranoid.
 *
 * `unlinkEventVenue` was built, tested, audited — and had **no caller**, so an
 * organiser could not. The sentence was load-bearing for a security posture and
 * it was false: a wrong approval handed somebody `canOperate` on an event, and
 * the recovery the queue was relaxed on the strength of did not exist.
 *
 * That is the failure the reachability ratchet's own docblock names as the
 * expensive one — not the wasted code, the documentation that becomes untrue.
 *
 * ## A reason, because it is recorded against the venue
 *
 * The action refuses a short one. An unlink is evidence in a later claim
 * dispute, and "no" is not evidence.
 */
export function EventVenueLink({
  eventId,
  venueName,
}: {
  eventId: string
  venueName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="underline decoration-border-strong underline-offset-[3px] hover:text-foreground"
      >
        · Not at {venueName}?
      </button>
    )
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-2">
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this not at that venue? Recorded against the venue."
        rows={2}
        autoFocus
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={pending || reason.trim().length < 10}
          onClick={() =>
            start(async () => {
              try {
                await unlinkEventVenue(eventId, reason)
                toast.success("Unlinked")
                setOpen(false)
                router.refresh()
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not unlink")
              }
            })
          }
        >
          {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
          Unlink
        </Button>
      </div>
    </div>
  )
}
