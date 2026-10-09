"use client"

import Script from "next/script"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cancelAnalytics, startAnalyticsCheckout, startEventPassCheckout } from "@/lib/billing-actions"
import { BILLING_PLANS, grossRupees, gstSplit, rupees } from "@/lib/billing-plans"
import { refusalMessage } from "@/lib/refusal"
import { cn } from "@/lib/utils"

/**
 * Razorpay Checkout on the Plan page.
 *
 * The server action starts the purchase and returns only an id and the
 * publishable key id. Checkout takes the payment in its own frame. When it
 * reports success, this page goes to `?status=pending` and refreshes: it does
 * not tell the server anything, because the server does not believe it. The
 * plan changes when Razorpay's signed webhook arrives.
 */

interface RazorpayCheckout {
  open(): void
  on(event: "payment.failed", handler: (response: unknown) => void): void
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckout
  }
}

/** Loaded only for someone who can buy, once payments are on (CSP: lib/csp-report.ts). */
export function CheckoutScript() {
  return <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="lazyOnload" />
}

function useCheckout() {
  const router = useRouter()
  return (options: Record<string, unknown>) => {
    if (!window.Razorpay) {
      toast.error("Checkout is still loading. Try again in a moment.")
      return
    }
    const checkout = new window.Razorpay({
      name: "Blend'n",
      theme: { color: "#f05423" },
      ...options,
      handler: () => {
        router.push("/dashboard/plan?status=pending")
        router.refresh()
      },
    })
    checkout.on("payment.failed", () => toast.error("The payment didn't go through. Nothing was charged."))
    checkout.open()
  }
}

export function AnalyticsBuy({ enabled }: { enabled: boolean }) {
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly")
  const [pending, start] = useTransition()
  const open = useCheckout()
  const plan = BILLING_PLANS[period === "monthly" ? "analytics_monthly" : "analytics_yearly"]
  const price = rupees(grossRupees(plan))
  const per = period === "monthly" ? "month" : "year"

  function buy() {
    start(async () => {
      try {
        const checkout = await startAnalyticsCheckout(period)
        open({
          key: checkout.keyId,
          subscription_id: checkout.subscriptionId,
          description: `${plan.label} · ${price} incl. GST`,
        })
      } catch (err) {
        toast.error(refusalMessage(err, "Couldn't start the payment."))
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Billing period" className="inline-flex w-fit rounded-full border border-border p-0.5 text-[0.78125rem]">
        {(["monthly", "yearly"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={period === p}
            onClick={() => setPeriod(p)}
            className={cn(
              "rounded-full px-2.5 py-1 pointer-coarse:min-h-11",
              period === p ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {p === "monthly" ? "Monthly" : "Yearly"}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-[1.625rem] font-bold tabular-nums">
          {price} <span className="text-[0.8125rem] font-normal text-muted-foreground">/ {per}</span>
        </p>
        <p className="text-[0.75rem] tabular-nums text-faint-foreground">
          {gstSplit(plan)} · renews {period}, cancel any time
        </p>
      </div>
      <Button disabled={!enabled || pending} onClick={buy}>
        {pending ? "Starting…" : `Start Analytics · ${price} / ${per}`}
      </Button>
    </div>
  )
}

export function EventPassBuy({ enabled, events }: { enabled: boolean; events: { id: string; label: string }[] }) {
  const [eventId, setEventId] = useState(events[0]?.id ?? "")
  const [pending, start] = useTransition()
  const open = useCheckout()
  const price = rupees(grossRupees(BILLING_PLANS.event_pass))

  if (events.length === 0) {
    return <p className="text-[0.8125rem] text-muted-foreground">Every event you have already has a pass, or you haven&apos;t run one yet.</p>
  }

  function buy() {
    start(async () => {
      try {
        const checkout = await startEventPassCheckout(eventId)
        open({
          key: checkout.keyId,
          order_id: checkout.orderId,
          amount: checkout.amountMinor,
          currency: "INR",
          description: `Event Pass · ${price} incl. GST`,
        })
      } catch (err) {
        toast.error(refusalMessage(err, "Couldn't start the payment."))
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-[0.75rem] text-muted-foreground">
        Event
        <select
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-[0.8125rem] text-foreground"
        >
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <Button variant="outline" disabled={!enabled || pending || !eventId} onClick={buy}>
        {pending ? "Starting…" : `Buy Event Pass · ${price}`}
      </Button>
    </div>
  )
}

export function CancelAnalytics({ running }: { running: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const [pending, start] = useTransition()
  const router = useRouter()

  if (!confirming) {
    return (
      <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
        {running ? "Cancel at the end of this cycle" : "Cancel subscription"}
      </Button>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
      <span>{running ? "Analytics stays on until the cycle ends, then stops." : "Analytics stops now."}</span>
      <Button
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              await cancelAnalytics()
              toast.success("Cancelled. Razorpay will confirm it shortly.")
              setConfirming(false)
              router.refresh()
            } catch (err) {
              toast.error(refusalMessage(err, "Couldn't cancel."))
            }
          })
        }
      >
        Cancel it
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
        Keep it
      </Button>
    </div>
  )
}
