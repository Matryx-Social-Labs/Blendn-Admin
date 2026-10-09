"use client"

import Script from "next/script"
import { useRouter } from "next/navigation"
import { createContext, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cancelAnalytics, startAnalyticsCheckout, startEventPassCheckout } from "@/lib/billing-actions"
import { BILLING_PLANS, grossRupees, gstSplit, rupees } from "@/lib/billing-plans"
import { refusalMessage } from "@/lib/refusal"

/**
 * Razorpay Checkout on the Plan page.
 *
 * The script loads once (`CheckoutProvider`); Buy stays unavailable until it
 * is ready, and says so if it could not load. The server action is called only
 * once `window.Razorpay` exists, so a click never leaves an unpaid purchase
 * behind for a sheet that cannot open. The action returns only an id and the
 * publishable key id; Checkout takes the payment in its own frame.
 *
 * When Checkout reports success the page goes to `?status=pending` and waits
 * for the server: it does not tell the server anything, because the server
 * does not believe it. The plan changes when Razorpay's signed webhook arrives
 * (`PendingWatcher`).
 */

interface RazorpayFailure {
  error?: { description?: string }
}

interface RazorpayCheckout {
  open(): void
  on(event: "payment.failed", handler: (response: RazorpayFailure) => void): void
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckout
  }
}

type ScriptState = "loading" | "ready" | "failed"
const CheckoutContext = createContext<{ state: ScriptState; retry: () => void }>({ state: "loading", retry: () => {} })

/** Loads Checkout.js once for the page (CSP: lib/csp-report.ts). Only rendered for someone who can buy. */
export function CheckoutProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ScriptState>(() =>
    typeof window !== "undefined" && window.Razorpay ? "ready" : "loading"
  )
  const [attempt, setAttempt] = useState(0)
  return (
    <CheckoutContext.Provider value={{ state, retry: () => (setState("loading"), setAttempt((n) => n + 1)) }}>
      <Script
        key={attempt}
        src="https://checkout.razorpay.com/v1/checkout.js"
        strategy="afterInteractive"
        onReady={() => setState("ready")}
        onError={() => setState("failed")}
      />
      {children}
    </CheckoutContext.Provider>
  )
}

/** What a Buy button needs: whether it may be pressed now, and why not. */
function useBuy(enabled: boolean, pending: boolean) {
  const { state, retry } = useContext(CheckoutContext)
  const reason = !enabled
    ? null
    : pending
      ? "A payment is being confirmed. This page updates when Razorpay confirms it."
      : state === "loading"
        ? "Checkout is loading…"
        : state === "failed"
          ? "Checkout couldn't load."
          : null
  return { usable: enabled && !pending && state === "ready", reason, failed: enabled && state === "failed", retry }
}

function Unavailable({ reason, failed, retry }: { reason: string | null; failed: boolean; retry: () => void }) {
  if (!reason) return null
  return (
    <p className="text-[0.75rem] text-muted-foreground">
      {reason}{" "}
      {failed ? (
        <button type="button" className="underline underline-offset-2" onClick={retry}>
          Try again
        </button>
      ) : null}
    </p>
  )
}

/** Open Checkout. Success leaves for the pending page; failure says Razorpay's own reason, inline. */
function useOpen(onFailed: (message: string) => void, returnFocus: () => void) {
  const router = useRouter()
  return (options: Record<string, unknown>, pendingFor: string, ref: string) => {
    const Checkout = window.Razorpay
    if (!Checkout) return false
    const checkout = new Checkout({
      name: "Blend'n",
      theme: { color: "#f05423" },
      ...options,
      modal: { ondismiss: returnFocus },
      handler: () => router.push(`/dashboard/plan?status=pending&for=${pendingFor}&ref=${encodeURIComponent(ref)}`),
    })
    checkout.on("payment.failed", (response) =>
      onFailed(response.error?.description ?? "Razorpay couldn't complete the payment.")
    )
    checkout.open()
    return true
  }
}

function Failure({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-[0.8125rem] text-destructive">
      {message} If your account was debited, Razorpay&apos;s receipt has the reference to quote.
    </p>
  ) : null
}

export function AnalyticsBuy({ enabled, pending }: { enabled: boolean; pending: boolean }) {
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly")
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const button = useRef<HTMLButtonElement>(null)
  const buy = useBuy(enabled, pending)
  const open = useOpen(setFailure, () => button.current?.focus())
  const plan = BILLING_PLANS[period === "monthly" ? "analytics_monthly" : "analytics_yearly"]
  const price = rupees(grossRupees(plan))
  const per = period === "monthly" ? "month" : "year"

  function onBuy() {
    if (!buy.usable || busy || !window.Razorpay) return
    setFailure(null)
    start(async () => {
      try {
        const checkout = await startAnalyticsCheckout(period)
        open({ key: checkout.keyId, subscription_id: checkout.subscriptionId, description: `${plan.label} · ${price} incl. GST` }, "analytics", checkout.subscriptionId)
      } catch (err) {
        toast.error(refusalMessage(err, "Couldn't start the payment."))
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex w-fit gap-0.5 rounded-full border border-border p-0.5 text-[0.78125rem]">
        <legend className="sr-only">Billing period</legend>
        {(["monthly", "yearly"] as const).map((p) => (
          <label
            key={p}
            className="cursor-pointer rounded-full px-2.5 py-1 text-muted-foreground has-[:checked]:bg-accent has-[:checked]:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring pointer-coarse:min-h-11"
          >
            <input type="radio" name="analytics-period" value={p} checked={period === p} onChange={() => setPeriod(p)} className="sr-only" />
            {p === "monthly" ? "Monthly" : "Yearly"}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <p className="text-[1.625rem] font-bold tabular-nums">
          {price} <span className="text-[0.8125rem] font-normal text-muted-foreground">/ {per}</span>
        </p>
        <p className="text-[0.75rem] tabular-nums text-faint-foreground">
          {gstSplit(plan)} · renews {period}, cancel any time
        </p>
      </div>
      <Button ref={button} aria-disabled={!buy.usable || busy} onClick={onBuy}>
        {busy ? "Starting…" : `Start Analytics · ${price} / ${per}`}
      </Button>
      <Unavailable reason={buy.reason} failed={buy.failed} retry={buy.retry} />
      <Failure message={failure} />
    </div>
  )
}

export function EventPassBuy({
  enabled,
  pending,
  events,
}: {
  enabled: boolean
  pending: boolean
  events: { id: string; label: string }[]
}) {
  const [chosen, setChosen] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const button = useRef<HTMLButtonElement>(null)
  const buy = useBuy(enabled, pending)
  const open = useOpen(setFailure, () => button.current?.focus())
  const price = rupees(grossRupees(BILLING_PLANS.event_pass))
  // From the props every render: an event that has since been passed, or
  // left the list, is never the one bought.
  const eventId = events.find((e) => e.id === chosen)?.id ?? events[0]?.id ?? ""

  if (events.length === 0) {
    return <p className="text-[0.8125rem] text-muted-foreground">Every event you have already has a pass, or you haven&apos;t run one yet.</p>
  }

  function onBuy() {
    if (!buy.usable || busy || !eventId || !window.Razorpay) return
    setFailure(null)
    start(async () => {
      try {
        const checkout = await startEventPassCheckout(eventId)
        open(
          { key: checkout.keyId, order_id: checkout.orderId, amount: checkout.amountMinor, currency: "INR", description: `Event Pass · ${price} incl. GST` },
          "pass",
          checkout.orderId
        )
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
          onChange={(e) => setChosen(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-[0.8125rem] text-foreground"
        >
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <Button ref={button} variant="outline" aria-disabled={!buy.usable || busy || !eventId} onClick={onBuy}>
        {busy ? "Starting…" : `Buy Event Pass · ${price}`}
      </Button>
      <Unavailable reason={buy.reason} failed={buy.failed} retry={buy.retry} />
      <Failure message={failure} />
    </div>
  )
}

/** Every 4 s for up to 90 s, ask the server again; then say it is taking longer, with the reference. */
const WATCH_EVERY_MS = 4_000
const WATCH_FOR_MS = 90_000

export function PendingWatcher({ reference }: { reference: string | null }) {
  const router = useRouter()
  const [late, setLate] = useState(false)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - started >= WATCH_FOR_MS) {
        clearInterval(timer)
        setLate(true)
        return
      }
      router.refresh()
    }, WATCH_EVERY_MS)
    return () => clearInterval(timer)
  }, [router])
  if (!late) return null
  return (
    <p className="text-[0.8125rem] text-muted-foreground">
      Taking longer than usual. Razorpay&apos;s reference is <span className="font-mono">{reference ?? "on your receipt"}</span>; if
      this page hasn&apos;t changed in an hour, write to support@blendn.app with it.
    </p>
  )
}

export function CancelAnalytics({ running }: { running: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, start] = useTransition()

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
        aria-disabled={busy}
        onClick={() =>
          !busy &&
          start(async () => {
            try {
              await cancelAnalytics()
              toast.success("Cancelled. Razorpay will confirm it shortly.")
              setConfirming(false)
            } catch (err) {
              toast.error(refusalMessage(err, "Couldn't cancel."))
            }
          })
        }
      >
        Cancel it
      </Button>
      <Button size="sm" variant="ghost" aria-disabled={busy} onClick={() => !busy && setConfirming(false)}>
        Keep it
      </Button>
    </div>
  )
}
