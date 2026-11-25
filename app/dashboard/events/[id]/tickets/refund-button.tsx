"use client"

import { useId, useRef } from "react"
import { IconLoader2 } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { formatMinor } from "@/lib/money"

import { refundSale } from "./actions"
import { useTicketAction } from "./use-action"

/**
 * One order's Refund, behind a confirmation (mockup state 5): who (the
 * label), how much, what stays or what it costs the organization, what happens at the door, how long the bank
 * takes. The whole order; the focused button is Keep. A native `<dialog>`,
 * so focus is held in it and Escape closes it.
 */
export function RefundButton(p: {
  eventId: string
  orderId: string
  orderRef: string
  label: string
  quantity: number
  types: string
  refundMinor: number
  bookingFeeMinor: number
  chargedFeesMinor: number
  currency: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const { pending, run } = useTicketAction()
  const money = (m: number) => formatMinor(m, p.currency, { paise: true })
  const tickets = `${p.quantity} ${p.types} ticket${p.quantity === 1 ? "" : "s"}`

  return (
    <>
      <button type="button" className="font-medium underline underline-offset-[3px] pointer-coarse:min-h-11" onClick={() => ref.current?.showModal()}>
        Refund<span className="sr-only"> order {p.orderRef}</span>
      </button>
      <dialog
        ref={ref}
        role="alertdialog"
        aria-labelledby={`${id}-t`}
        aria-describedby={p.chargedFeesMinor > 0 ? `${id}-d ${id}-l` : `${id}-d`}
        className="m-auto w-[460px] text-left max-w-[calc(100vw-2rem)] rounded-panel border border-border-strong bg-card p-[22px] text-foreground backdrop:bg-black/60"
      >
        <div className="flex flex-col gap-3">
          <h2 id={`${id}-t`} className="text-[1.0625rem] font-bold">
            Refund order <span className="font-mono text-base">{p.orderRef}</span>?
          </h2>
          <p id={`${id}-d`} className="text-sm leading-[1.55] text-muted-foreground">
            <span className="font-mono text-foreground">{p.label}</span>{" "}
            {p.chargedFeesMinor > 0 ? (
              `gets the full price of ${tickets} back.`
            ) : (
              <>
                gets <b className="text-foreground">{money(p.refundMinor)}</b> back, the price of {tickets}.
              </>
            )}
            {p.bookingFeeMinor > 0 ? ` The ${money(p.bookingFeeMinor)} booking fee is not refunded (Organizer Ticketing Terms 5.4).` : ""}{" "}
            {p.quantity === 1 ? "The ticket stops" : "The tickets stop"} working at the door straight away. Razorpay returns the money in 5–7 business days.
          </p>
          {p.chargedFeesMinor > 0 ? (
            <dl id={`${id}-l`} className="text-sm text-muted-foreground">
              <div className="flex justify-between gap-3 border-b border-border py-1.5">
                <dt>Buyer gets back</dt>
                <dd className="font-bold whitespace-nowrap tabular-nums text-foreground">{money(p.refundMinor)}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-border py-1.5">
                <dt>Fees you absorbed, charged to you</dt>
                <dd className="whitespace-nowrap tabular-nums text-foreground">{money(p.chargedFeesMinor)}</dd>
              </div>
            </dl>
          ) : null}
          <div className="mt-1.5 flex flex-wrap justify-end gap-2">
            <Button variant="outline" autoFocus onClick={() => ref.current?.close()}>
              Keep the order
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => run(() => refundSale(p.eventId, p.orderId), () => ref.current?.close())}>
              {pending ? <IconLoader2 aria-hidden className="animate-spin" /> : null}
              Refund {money(p.refundMinor)}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  )
}
