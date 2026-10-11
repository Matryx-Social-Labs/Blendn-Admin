"use client"

import { useRouter } from "next/navigation"
import { createContext, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react"
import { toast } from "sonner"

import { Callout } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import {
  cancelAnalytics,
  cancelVenuePro,
  startAnalyticsCheckout,
  startEventPassCheckout,
  startVenueProCheckout,
} from "@/lib/billing-actions"
import { BILLING_PLANS, grossRupees, gstSplit, rupees } from "@/lib/billing-plans"
import { loadScript } from "@/lib/load-script"
import { refusalMessage } from "@/lib/refusal"

/**
 * Razorpay Checkout on the Plan page.
 *
 * The script loads with the page (`CheckoutProvider`) and again on "Try again"
 * (`lib/load-script.ts`); Buy stays unavailable until it is ready, and says so
 * if it could not load. The server action is called only
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

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js"

/** Loads Checkout.js for the page (CSP: lib/csp-report.ts), again on retry. Only rendered for someone who can buy. */
export function CheckoutProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ScriptState>(() =>
    typeof window !== "undefined" && window.Razorpay ? "ready" : "loading"
  )
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    // Already there (the state started "ready"): nothing to load.
    if (window.Razorpay) return
    return loadScript(CHECKOUT_SRC, document, (loaded) => setState(loaded && window.Razorpay ? "ready" : "failed"))
  }, [attempt])
  return (
    <CheckoutContext.Provider value={{ state, retry: () => (setState("loading"), setAttempt((n) => n + 1)) }}>
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

/**
 * Why Buy cannot be pressed now. Loading and "being confirmed" are waiting, said
 * quietly; a script that could not load is the one state a person can act on, so
 * it is an alert in the destructive tone with a real button.
 */
export function Unavailable({ reason, failed, retry }: { reason: string | null; failed: boolean; retry: () => void }) {
  if (!reason) return null
  if (!failed) {
    return (
      <p role="status" className="text-[0.75rem] text-muted-foreground">
        {reason}
      </p>
    )
  }
  return (
    <p role="alert" className="flex flex-wrap items-center gap-2.5 text-[0.75rem] text-destructive">
      <span>{reason}</span>
      <Button type="button" size="sm" variant="outline" className="text-foreground" onClick={retry}>
        Try again
      </Button>
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
  return <SubscriptionBuy enabled={enabled} pending={pending} product="analytics" />
}

/** Venue Pro for one venue (step 17), monthly or yearly, as Analytics is bought. */
export function VenueProBuy({ venueId, enabled, pending }: { venueId: string; enabled: boolean; pending: boolean }) {
  return <SubscriptionBuy enabled={enabled} pending={pending} product="venue_pro" venueId={venueId} />
}

function SubscriptionBuy({
  enabled,
  pending,
  product,
  venueId,
}: {
  enabled: boolean
  pending: boolean
  product: "analytics" | "venue_pro"
  venueId?: string
}) {
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly")
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const button = useRef<HTMLButtonElement>(null)
  const buy = useBuy(enabled, pending)
  const open = useOpen(setFailure, () => button.current?.focus())
  const plan = BILLING_PLANS[`${product}_${period}`]
  const price = rupees(grossRupees(plan))
  const per = period === "monthly" ? "month" : "year"
  const name = product === "analytics" ? "Analytics" : "Venue Pro"

  function onBuy() {
    if (!buy.usable || busy || !window.Razorpay) return
    setFailure(null)
    start(async () => {
      try {
        const checkout = venueId ? await startVenueProCheckout(venueId, period) : await startAnalyticsCheckout(period)
        open(
          { key: checkout.keyId, subscription_id: checkout.subscriptionId, description: `${plan.label} · ${price} incl. GST` },
          product === "analytics" ? "analytics" : "venue",
          checkout.subscriptionId
        )
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
            <input type="radio" name={`${product}-period-${venueId ?? "org"}`} value={p} checked={period === p} onChange={() => setPeriod(p)} className="sr-only" />
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
        {busy ? "Starting…" : `Start ${name} · ${price} / ${per}`}
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

/** The late state: a status callout under the "Payment sent" panel, naming the reference support will ask for. */
export function LateNotice({ reference }: { reference: string | null }) {
  return (
    <Callout role="status" title="Taking longer than usual">
      Razorpay&apos;s reference is <span className="font-mono text-foreground">{reference ?? "on your receipt"}</span>. If this page
      hasn&apos;t changed in an hour, write to support@blendn.app with it.
    </Callout>
  )
}

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
  return late ? <LateNotice reference={reference} /> : null
}

export function CancelAnalytics({ running, venueId }: { running: boolean; venueId?: string }) {
  const name = venueId ? "Venue Pro" : "Analytics"
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
      <span>{running ? `${name} stays on until the cycle ends, then stops.` : `${name} stops now.`}</span>
      <Button
        size="sm"
        variant="destructive"
        aria-disabled={busy}
        onClick={() =>
          !busy &&
          start(async () => {
            try {
              await (venueId ? cancelVenuePro(venueId) : cancelAnalytics())
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
