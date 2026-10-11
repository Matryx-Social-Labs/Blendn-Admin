"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { endOffer } from "@/lib/offer-actions"
import { refusalMessage } from "@/lib/refusal"

/** An admin ends a live offer now, saying why (step 12 review M5). Its passes stop at once; audited. */
export function EndOfferButton({ offerId }: { offerId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()
  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        End
      </Button>
    )
  }
  const submit = () =>
    start(async () => {
      try {
        await endOffer({ offerId, reason })
        toast.success("Offer ended. Its passes no longer work.")
        setOpen(false)
        router.refresh()
      } catch (err) {
        toast.error(refusalMessage(err, "The offer couldn't be ended. Try again."))
      }
    })
  return (
    <div className="flex flex-col items-end gap-2">
      <label htmlFor={`end-${offerId}`} className="sr-only">
        Why end this offer
      </label>
      <Textarea id={`end-${offerId}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (reported, misleading…)" />
      <Button size="sm" variant="destructive" onClick={submit} aria-disabled={pending || reason.trim().length < 10}>
        {pending ? "Ending…" : "End offer"}
      </Button>
    </div>
  )
}
