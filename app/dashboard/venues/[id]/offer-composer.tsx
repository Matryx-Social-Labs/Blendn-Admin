"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { sendOffer } from "@/lib/offer-actions"
import { refusalMessage } from "@/lib/refusal"

/**
 * Write an offer for the venue's regulars and send it (step 12).
 *
 * The server decides everything that matters — Venue Pro, the quota, the
 * words, who gets it, and whether enough do (`lib/offer-actions.ts`). This
 * shows its answer: how many it reached, or why nothing was sent. The panel
 * draws it only while the week's quota has room. There is
 * no "how many would get this" before sending: a count of a small group that
 * anyone could re-ask would let a venue watch one person become a regular.
 */

const MAX = 140
const DAY_CHOICES = [3, 7, 14] as const

export function OfferComposer({ venueId }: { venueId: string }) {
  const router = useRouter()
  const [text, setText] = useState("")
  const [days, setDays] = useState<number>(7)
  const [pending, start] = useTransition()
  const empty = text.trim().length === 0

  function send() {
    if (empty || pending) return
    start(async () => {
      try {
        const { reached } = await sendOffer({ venueId, text, days })
        toast.success(`Sent to ${reached} regulars. Opens and redemptions show as weekly totals — never who.`)
        setText("")
        router.refresh()
      } catch (err) {
        toast.error(refusalMessage(err, "The offer couldn't be sent. Try again."))
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="offer-text" className="text-[0.75rem] text-muted-foreground">
        Offer
      </label>
      <Textarea
        id="offer-text"
        value={text}
        maxLength={MAX}
        rows={2}
        placeholder="First drink on the house, Thu–Sun before 10"
        onChange={(e) => setText(e.target.value)}
        // The rule, from the server's own constants, is printed by the panel beside this (`offer-rule`).
        aria-describedby="offer-rule"
      />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[0.75rem] tabular-nums text-faint-foreground">
          {text.length} / {MAX}
        </span>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-[0.75rem] text-muted-foreground">
          Lasts
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-[0.8125rem] text-foreground"
          >
            {DAY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <Button onClick={send} aria-disabled={empty || pending}>
          {pending ? "Sending…" : "Send to regulars"}
        </Button>
      </div>
    </div>
  )
}
